/**
 * Rebuild a delegate's model context from its persisted transcript rows
 * (ADR 0279).
 *
 * Every row a delegate emits lands in the session transcript with
 * `parentToolCallId` (the `Task` call that spawned it) and `agentName`. Those
 * rows are written for review and never replayed into the parent's context
 * (`runtime.ts` skips them on rebuild) — but they carry everything a resumed
 * delegate needs: tool call/result pairs, thinking blocks, and the original
 * `task` on the first `Task` tool row's arguments.
 *
 * A chain is the sequence of `Task` calls that share one delegate session: the
 * first call plus every `resume`. Rows are keyed by the *call*, so
 * reconstructing the chain means selecting every row whose `parentToolCallId`
 * is one of the chain's calls.
 *
 * The conversion mirrors `historyToEntries` in `runtime.ts` (failed assistant
 * rows stay transcript-only, tool rows attach to the assistant above them, an
 * orphan tool row gets a synthesized carrier) but is parameterized by the
 * delegate's own provider: a pinned delegation model is not the session model,
 * and api/replay details depend on the binding.
 */

import { estimateTokens } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  Model,
  Api,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  MAX_RESUMABLE_LISTED_FILES,
  MAX_RESUMABLE_READ_LINES,
  normalizeSubagentName,
  type UiMessage,
} from "@pi-desktop/shared";
import { isRecord, timestampMs, toJsonObject, toJsonValue, usageToPi } from "./agent-messages.js";
import type { ContextBudgetLimits } from "./context-budget.js";
import {
  apiBindingForProviderModel,
  type RuntimeProviderConfig,
} from "./provider-binding.js";

/** One chain of `Task` calls that share a delegate session. */
export type DelegationChain = {
  /** Stable identity across every `resume`; never appears in a tool or prompt. */
  delegateSessionId: string;
  /** Every `Task` toolCallId on this chain, oldest first. */
  toolCallIds: string[];
  /** Every `delegationId` issued on this chain, oldest first. */
  delegationIds: string[];
  agentName: string;
  /** Read-only tool targets, accumulated across the whole chain. */
  readFiles: string[];
  /** Cumulative lines the chain's read-only tools have produced. */
  readLineCount: number;
  /** First `task` brief; seeds the resumed run's opening user turn. */
  originalTask?: string;
  /** Settled `delegationId` of the chain's latest run, for the prompt listing. */
  latestDelegationId?: string;
  /** Latest run's one-line objective, from the `description` or `task` text. */
  latestObjective?: string;
  /** Provider/model used by the latest run; resume must keep it. */
  latestModelId?: string;
  /** `providerId/modelId` key the latest run resolved (ADR 0279 §4). */
  latestModelKey?: string;
  /** Settled status of the latest run; `running` while it works. Owns the
   * resumability gate so pruning finished delegation records cannot make a
   * stopped chain look reusable (ADR 0279). */
  latestStatus?: string;
  /** Latest activity timestamp, used for LRU eviction. */
  lastActivityAt: number;
};

export type ResumableChain = DelegationChain & {
  latestDelegationId: string;
  latestObjective: string;
};

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "BrowserPreview"]);
const MISSING_TOOL_RESULT_PLACEHOLDER = "[no tool result recorded]";

export function isReadOnlyToolName(name: string): boolean {
  return READ_TOOLS.has(name);
}

/**
 * Extract read-only tool targets from a delegate's tool rows. Write-tool
 * targets are deliberately excluded: the parent needs to know what a delegate
 * *saw*, and write serialization is already the path lock's job.
 */
export function extractReadFiles(rows: readonly UiMessage[]): {
  files: string[];
  lineCount: number;
} {
  const files: string[] = [];
  let lineCount = 0;
  for (const row of rows) {
    if (row.role !== "tool" || !row.toolName || !READ_TOOLS.has(row.toolName)) {
      continue;
    }
    const target = readToolTarget(row);
    if (target) files.push(target);
    lineCount += readToolLineCount(row);
  }
  return { files: uniquePreserveOrder(files), lineCount };
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function readToolTarget(row: UiMessage): string | undefined {
  const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
  const direct =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.file_path === "string"
        ? args.file_path
        : typeof args?.pattern === "string"
          ? args.pattern
          : undefined;
  return direct?.trim() || undefined;
}

function readToolLineCount(row: UiMessage): number {
  const text = toolResultText(row);
  if (!text) return 0;
  // A line count is all this gate needs; exact accounting is not load-bearing.
  return text.split("\n").length;
}

function toolResultText(row: UiMessage): string | undefined {
  const raw = row.toolResult;
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return undefined;
  const content = raw.content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        isRecord(block) && typeof block.text === "string" ? block.text : "",
      )
      .join("\n");
  }
  if (typeof raw.text === "string") return raw.text;
  return undefined;
}

/**
 * Select this chain's rows out of a session transcript, in order.
 *
 * `Task` tool rows themselves carry no `parentToolCallId` (they belong to the
 * parent), so callers pass the chain's calls in and get back the delegate's own
 * rows only.
 */
export function selectChainRows(
  transcript: readonly UiMessage[],
  chain: Pick<DelegationChain, "toolCallIds" | "agentName">,
): UiMessage[] {
  const calls = new Set(chain.toolCallIds);
  return transcript.filter(
    (row) =>
      typeof row.parentToolCallId === "string" &&
      calls.has(row.parentToolCallId) &&
      row.agentName === chain.agentName,
  );
}

/**
 * The first user turn of a resumed delegate is the original `task`, recovered
 * from the persisted `Task` tool arguments. Returns `undefined` when the row or
 * its arguments are gone (a truncated branch), in which case the chain is not
 * resumable and the caller reports it as unknown.
 */
export function originalTaskFromTranscript(
  transcript: readonly UiMessage[],
  chain: Pick<DelegationChain, "toolCallIds">,
): string | undefined {
  const first = chain.toolCallIds[0];
  if (!first) return undefined;
  const row = transcript.find(
    (candidate) =>
      candidate.role === "tool" &&
      candidate.toolName === "Task" &&
      candidate.toolCallId === first,
  );
  if (!row) return undefined;
  const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
  const task = typeof args?.task === "string" ? args.task.trim() : "";
  return task || undefined;
}

export function taskObjectiveFromArgs(args: unknown): string {
  if (!isRecord(args)) return "";
  const description =
    typeof args.description === "string" ? args.description.trim() : "";
  if (description) return description;
  const task = typeof args.task === "string" ? args.task.trim() : "";
  return task;
}

/**
 * Convert a delegate's transcript rows into provider messages.
 *
 * Mirrors the parent's rebuild: an assistant row carries its text and thinking;
 * a tool row appends its call to the assistant above it and emits a paired
 * result. An orphan tool row (its assistant lost to a truncated branch) gets a
 * synthesized carrier so the pair stays well-formed — providers reject an
 * unpaired `toolUse`.
 */
export function chainRowsToMessages(
  rows: readonly UiMessage[],
  provider: RuntimeProviderConfig,
  model: Model<Api>,
): Message[] {
  const api = apiBindingForProviderModel(provider).api;
  const deepSeekCompletionsReplay =
    api === "openai-completions" &&
    (
      model.compat as
        | { requiresReasoningContentOnAssistantMessages?: boolean }
        | undefined
    )?.requiresReasoningContentOnAssistantMessages === true;

  const messages: Message[] = [];
  let toolCarrier: AssistantMessage | undefined;

  for (const row of rows) {
    const timestamp = timestampMs(row.createdAt) || Date.now();
    if (row.role === "user") {
      toolCarrier = undefined;
      if (!(row.content || "").trim()) continue;
      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: row.content }],
        timestamp,
      };
      messages.push(userMessage);
    } else if (row.role === "assistant") {
      toolCarrier = undefined;
      // Failed provider responses stay transcript-only: replaying one would
      // hand the model a stopReason the provider never agreed to.
      if (row.status === "error" || row.isError || row.error) continue;
      const content: AssistantMessage["content"] = [];
      if (row.thinking?.trim()) {
        content.push({
          type: "thinking",
          thinking: row.thinking,
          ...(deepSeekCompletionsReplay
            ? { thinkingSignature: "reasoning_content" as const }
            : {}),
        });
      }
      if (row.content?.trim()) {
        content.push({ type: "text", text: row.content });
      }
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api,
        provider: provider.id,
        model: provider.modelId,
        usage: usageToPi(row.usage),
        stopReason: "stop",
        timestamp,
      };
      messages.push(assistant);
      toolCarrier = assistant;
    } else if (row.role === "tool") {
      if (!row.toolCallId || !row.toolName) continue;
      if (!toolCarrier) {
        toolCarrier = {
          role: "assistant",
          content: [],
          api,
          provider: provider.id,
          model: provider.modelId,
          usage: usageToPi(undefined),
          stopReason: "toolUse",
          timestamp,
        };
        messages.push(toolCarrier);
      }
      toolCarrier.content.push({
        type: "toolCall",
        id: row.toolCallId,
        name: row.toolName,
        arguments: toJsonObject(row.toolArgs),
      });
      toolCarrier.stopReason = "toolUse";
      messages.push(toolResultFromUi(row, timestamp));
    }
  }

  // A call-only turn with no text is a legitimate carrier; an assistant that
  // ended with neither text nor calls carries nothing to the model.
  return messages.filter(
    (message) =>
      message.role !== "assistant" || message.content.length > 0,
  );
}

/**
 * Seed a resumed run: original task as the first user turn, then history.
 *
 * The seed is truncated against the delegate's budget (ADR 0299 §7) so a
 * resumed run's first request fits its own window instead of overflowing on
 * arrival. Truncation drops the oldest tool results first and never splits a
 * call from its result; the task brief itself is always kept.
 */
export function seedDelegateMessages(options: {
  originalTask: string;
  rows: readonly UiMessage[];
  provider: RuntimeProviderConfig;
  model: Model<Api>;
  budget: ContextBudgetLimits;
}): Message[] {
  const history = chainRowsToMessages(options.rows, options.provider, options.model);
  const first: UserMessage = {
    role: "user",
    content: [{ type: "text", text: options.originalTask }],
    timestamp: timestampMs(options.rows[0]?.createdAt) || Date.now(),
  };
  const rest = history.filter(
    (message) =>
      !(
        message.role === "user" &&
        typeof message.content !== "string" &&
        message.content.length === 1 &&
        message.content[0]?.type === "text" &&
        message.content[0].text === options.originalTask
      ),
  );
  return truncateSeededMessages(
    [first, ...rest],
    options.budget.hardLimit,
  );
}

/**
 * Bring a seeded chain under the delegate's hard limit (ADR 0299 §7).
 *
 * `messages[0]` is the original task brief and is never dropped. The oldest
 * tool results go first: they are the bulkiest entries, and the delegate can
 * re-read a file but cannot reconstruct its most recent turns. A result always
 * leaves together with its call, and a carrier left with neither text nor
 * calls is removed too, so the replay never holds an orphaned `toolUse` /
 * `toolResult` pair (providers reject those). If stripping every pair is not
 * enough, whole messages go oldest-first until only the brief is left; a brief
 * that alone crosses the limit is kept as is, because a resume cannot start
 * with less than its task.
 *
 * Sizes are measured with the per-message heuristic rather than
 * `estimateContextTokens`: that estimator anchors on the last assistant's
 * recorded usage, which still counts the history this truncation drops, so the
 * anchor could never fall below the limit no matter how much is removed.
 */
function truncateSeededMessages(
  messages: Message[],
  hardLimit: number,
): Message[] {
  const kept = [...messages];
  const tokenCounts = kept.map((message) => estimateTokens(message));
  let total = tokenCounts.reduce((sum, count) => sum + count, 0);
  if (total < hardLimit) return kept;

  // Phase 1: strip tool call/result pairs, oldest first.
  for (let i = 1; i < kept.length && total >= hardLimit; ) {
    const message = kept[i];
    if (message.role !== "assistant") {
      i += 1;
      continue;
    }
    const callIds = new Set(
      message.content
        .filter((block): block is ToolCall => block.type === "toolCall")
        .map((block) => block.id),
    );
    if (callIds.size === 0) {
      i += 1;
      continue;
    }
    const content = message.content.filter((block) => block.type !== "toolCall");
    // A carrier whose calls are gone must not keep claiming "toolUse" — the
    // replay would hand the model a stopReason no provider produced (the same
    // rule chainRowsToMessages applies to failed rows above).
    const carrier: AssistantMessage | undefined =
      content.length > 0 ? { ...message, content, stopReason: "stop" } : undefined;
    const carrierTokens = carrier ? estimateTokens(carrier) : 0;
    // A carrier's results sit directly behind it, one per call, in order.
    let end = i + 1;
    while (end < kept.length) {
      const next = kept[end];
      if (next.role !== "toolResult" || !callIds.has(next.toolCallId)) break;
      total -= tokenCounts[end];
      end += 1;
    }
    total -= tokenCounts[i] - carrierTokens;
    kept.splice(i, end - i, ...(carrier ? [carrier] : []));
    tokenCounts.splice(i, end - i, ...(carrier ? [carrierTokens] : []));
  }

  // Phase 2: no pairs remain; drop whole messages oldest-first down to the
  // brief.
  for (let i = 1; i < kept.length && total >= hardLimit; ) {
    total -= tokenCounts[i];
    kept.splice(i, 1);
    tokenCounts.splice(i, 1);
  }
  return kept;
}

function toolResultFromUi(m: UiMessage, timestamp: number): ToolResultMessage {
  const raw = m.toolResult;
  const blocks: ToolResultMessage["content"] = [];
  const rawBlocks =
    isRecord(raw) && Array.isArray(raw.content) ? raw.content : undefined;
  if (rawBlocks) {
    for (const block of rawBlocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        blocks.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
      }
    }
  } else if (typeof raw === "string" && raw.trim()) {
    blocks.push({ type: "text", text: raw });
  } else if (raw !== undefined && raw !== null) {
    blocks.push({ type: "text", text: safeJson(raw) });
  }
  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      text:
        m.toolStatus === "running"
          ? "[tool call was interrupted before a result was recorded]"
          : MISSING_TOOL_RESULT_PLACEHOLDER,
    });
  }
  const details = toJsonValue(isRecord(raw) ? raw.details : undefined);
  return {
    role: "toolResult",
    toolCallId: m.toolCallId ?? "",
    toolName: m.toolName ?? "",
    content: blocks,
    ...(details !== undefined ? { details } : {}),
    isError:
      m.toolStatus === "running" ||
      m.toolStatus === "error" ||
      m.toolStatus === "denied" ||
      m.isError === true,
    timestamp,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type RebuiltTaskCall = {
  toolCallId: string;
  delegationId: string;
  agentName: string;
  resume?: string;
  objective: string;
  task?: string;
  modelId?: string;
  createdAt: number;
  /** Settled status this call's `Task` row recorded, when it recorded one. */
  status?: string;
};
/**
 * Status a rebuilt chain carries after a restart (ADR 0279 §12). The settled
 * status is the one the settlement projection wrote onto the `Task` row. A run
 * the app closed while it still worked never settled, and reads as
 * `interrupted` rather than staying open forever. A row that records no status
 * at all — nothing this app writes does — is trusted as settled, because the
 * only alternative is to refuse every chain a partial transcript proves
 * nothing about.
 */
function chainStatusFromDetail(
  details: Record<string, unknown> | undefined,
  row: UiMessage,
): string | undefined {
  const status =
    typeof details?.status === "string" ? details.status.trim() : "";
  if (status) return status === "running" ? "interrupted" : status;
  if (row.toolStatus === "error") return "failed";
  if (row.toolStatus === "running") return "interrupted";
  return undefined;
}

/**
 * Scan persisted `Task` tool rows and group them into chains by their
 * `resume` links. Used at session launch so a restart does not lose
 * resumability (ADR 0279 §12). Every call carries the status its own `Task`
 * row recorded, so a chain rebuilt here is resumable exactly when the live
 * registry would consider it resumable.
 */
export function rebuildChainsFromTranscript(
  transcript: readonly UiMessage[],
): DelegationChain[] {
  const calls: RebuiltTaskCall[] = [];
  const callIndexByToolCallId = new Map<string, number>();
  for (const row of transcript) {
    if (row.role !== "tool" || row.toolName !== "Task" || !row.toolCallId) {
      continue;
    }
    const args = isRecord(row.toolArgs) ? row.toolArgs : undefined;
    const details =
      isRecord(row.toolResult) && isRecord(row.toolResult.details)
        ? row.toolResult.details
        : undefined;
    const delegationId =
      typeof details?.delegationId === "string" ? details.delegationId : "";
    // A `Task` row with no delegation id never produced a delegate — the call
    // was rejected (unknown agent, empty brief) and its "result" is the tool
    // error. Such a row is not a chain and must not become one.
    if (!delegationId) continue;
    // `agentName` is compared against the definition name and against the
    // transcript rows' `agentName`, so it is normalized the same way the tool
    // normalizes `Task.agent` (ADR 0279 §12).
    const agentName = normalizeSubagentName(
      typeof args?.agent === "string"
        ? args.agent
        : typeof details?.agent === "string"
          ? details.agent
          : "",
    );
    if (!agentName) continue;
    const resume = typeof args?.resume === "string" ? args.resume.trim() : "";
    const task = typeof args?.task === "string" ? args.task.trim() : "";
    const modelId =
      typeof details?.modelId === "string" ? details.modelId : undefined;
    const call: RebuiltTaskCall = {
      toolCallId: row.toolCallId,
      delegationId,
      agentName,
      ...(resume ? { resume } : {}),
      objective: taskObjectiveFromArgs(args),
      ...(task ? { task } : {}),
      ...(modelId ? { modelId } : {}),
      status: chainStatusFromDetail(details, row),
      createdAt: timestampMs(row.createdAt) || Date.now(),
    };
    // Settling a delegation rewrites its `Task` row in place, so a transcript
    // that briefly holds both the immediate and the settled copy keeps the
    // newer one and the call is never rebuilt twice.
    const seenAt = callIndexByToolCallId.get(row.toolCallId);
    if (seenAt === undefined) {
      callIndexByToolCallId.set(row.toolCallId, calls.length);
      calls.push(call);
    } else {
      calls[seenAt] = call;
    }
  }

  const byDelegationId = new Map(calls.map((call) => [call.delegationId, call]));
  const children = new Map<string, RebuiltTaskCall[]>();
  const roots: RebuiltTaskCall[] = [];
  for (const call of calls) {
    if (!call.resume) {
      roots.push(call);
      continue;
    }
    const parent = byDelegationId.get(call.resume);
    if (!parent) {
      // A resume whose parent is gone is not a chain; skip it.
      continue;
    }
    const siblings = children.get(parent.delegationId) ?? [];
    siblings.push(call);
    children.set(parent.delegationId, siblings);
  }

  const chains: DelegationChain[] = [];
  for (const root of roots) {
    const ordered: RebuiltTaskCall[] = [];
    const walk = (call: RebuiltTaskCall) => {
      ordered.push(call);
      for (const child of children.get(call.delegationId) ?? []) {
        if (child.agentName !== root.agentName) continue;
        walk(child);
      }
    };
    walk(root);
    const toolCallIds = ordered.map((call) => call.toolCallId);
    const rows = selectChainRows(transcript, {
      toolCallIds,
      agentName: root.agentName,
    });
    const reads = extractReadFiles(rows);
    const latest = ordered[ordered.length - 1];
    chains.push({
      delegateSessionId: root.delegationId,
      toolCallIds,
      delegationIds: ordered.map((call) => call.delegationId),
      agentName: root.agentName,
      readFiles: reads.files,
      readLineCount: reads.lineCount,
      originalTask: root.task,
      latestDelegationId: latest?.delegationId,
      latestObjective: latest?.objective ?? root.objective,
      latestModelId: latest?.modelId,
      latestStatus: latest?.status,
      lastActivityAt: latest?.createdAt ?? root.createdAt,
    });
  }
  return chains;
}

export function isChainWithinReadBudget(
  chain: Pick<DelegationChain, "readLineCount">,
  budget = MAX_RESUMABLE_READ_LINES,
): boolean {
  return chain.readLineCount <= budget;
}

export function listedReadFiles(
  files: readonly string[],
  limit = MAX_RESUMABLE_LISTED_FILES,
): { files: string[]; omitted: number } {
  if (files.length <= limit) return { files: [...files], omitted: 0 };
  return { files: files.slice(0, limit), omitted: files.length - limit };
}

export function formatResumableList(chains: readonly ResumableChain[]): string {
  if (chains.length === 0) return "";
  const lines = [
    "Reusable subagent sessions (same conversation only). To continue one, pass its `resume` id on Task. Saying \"reuse\" in prose is not enough; omit `resume` to start a new session. Do not pass `model` when resuming.",
  ];
  for (const chain of chains) {
    const listed = listedReadFiles(chain.readFiles);
    const files =
      listed.files.length === 0
        ? "none recorded"
        : listed.omitted > 0
          ? `${listed.files.join(", ")} (+${listed.omitted} more)`
          : listed.files.join(", ");
    lines.push(
      `- ${chain.agentName} / ${chain.latestDelegationId}: ${chain.latestObjective || "(no label)"}`,
    );
    lines.push(`  Files read: ${files}`);
  }
  return lines.join("\n");
}
