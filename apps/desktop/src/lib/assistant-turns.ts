import type {
  ContextCompactionMark,
  MessageUsage,
  UiMessage,
} from "@pi-desktop/shared";
import { isDelegationStartTool } from "./tool-display";

export type AssistantActivityItem =
  | { kind: "thinking"; message: UiMessage }
  | {
      kind: "tool";
      message: UiMessage;
      /** Present on a `Task` call: what the delegate it spawned did. */
      delegate?: SubagentRun;
    };

/** One row a delegate produced, in the order the delegate produced it. */
export type SubagentRunItem =
  | { kind: "thinking"; message: UiMessage }
  | { kind: "tool"; message: UiMessage }
  | { kind: "answer"; message: UiMessage };

/**
 * Everything one delegate did inside a single `Task` call (ADR 0062).
 *
 * Delegate rows arrive on the session stream interleaved with the parent's —
 * parallel delegates guarantee it — so they are collected by the `Task` call
 * that spawned them and rendered under it. That mirrors the model's view: the
 * parent only ever sees the report, never these rows.
 */
export type SubagentRun = {
  /** Definition name, when the runtime attributed the rows to one. */
  agentName?: string;
  items: SubagentRunItem[];
};

export type AssistantTurnPart =
  | { kind: "message"; message: UiMessage }
  | {
      kind: "activity";
      items: AssistantActivityItem[];
      endedAt?: string;
    };

export type AssistantTurnEntry = {
  kind: "assistant-turn";
  id: string;
  anchorId?: string;
  /**
   * `createdAt` of the user row that opened this turn: when the user sent the
   * prompt, so the reply's total can be measured from that moment.
   */
  startedAt?: string;
  parts: AssistantTurnPart[];
};

export type TranscriptEntry =
  | { kind: "message"; message: UiMessage }
  | { kind: "compaction"; mark: ContextCompactionMark }
  | AssistantTurnEntry;

export function messageThinking(message: UiMessage): string {
  if (typeof message.thinking !== "string") return "";
  return message.thinking.trim() ? message.thinking : "";
}

function isVisibleMessage(message: UiMessage): boolean {
  return !(
    message.role === "assistant" &&
    !(message.content || "").trim() &&
    !messageThinking(message) &&
    !message.error
  );
}

/** A `Task` start call belongs on the delegation card; parent thinking, workspace
 * tools, and lifecycle rows (TaskWait/TaskList/TaskStop) do not (D319). */
function isDelegationStartActivity(item: AssistantActivityItem): boolean {
  return item.kind === "tool" && isDelegationStartTool(item.message.toolName);
}

/** Delegate rows grouped by the `Task` call that produced them, chains merged. */
function collectSubagentRuns(
  messages: readonly UiMessage[],
): Map<string, SubagentRun> {
  const latestCall = chainLatestCalls(messages);
  const runs = new Map<string, SubagentRun>();
  for (const message of messages) {
    const parent = message.parentToolCallId;
    if (!parent) continue;
    const key = latestCall(parent);
    let run = runs.get(key);
    if (!run) {
      run = { items: [] };
      runs.set(key, run);
    }
    if (message.agentName && !run.agentName) run.agentName = message.agentName;
    if (message.role === "tool") {
      run.items.push({ kind: "tool", message });
      continue;
    }
    // A delegate turn can carry reasoning and text at once, and both are worth
    // showing: the text is the only place its narration and report exist.
    const thinking = messageThinking(message);
    if (thinking) run.items.push({ kind: "thinking", message });
    if ((message.content || "").trim() || message.error) {
      run.items.push({ kind: "answer", message });
    }
  }
  return runs;
}

// Map each Task call to the last call of its chain (ADR 0279): a resumed
// delegation is one delegate session continued by a later Task call, so the
// chain's rows all belong on the latest card, where they read as one
// continuing conversation rather than a card per call.
function chainLatestCalls(
  messages: readonly UiMessage[],
): (toolCallId: string) => string {
  const callByDelegationId = new Map<string, string>();
  const childOf = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) {
      continue;
    }
    const toolCallId = message.toolCallId;
    if (!toolCallId) continue;
    const result = message.toolResult;
    const details =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as { details?: unknown }).details
        : undefined;
    const delegationId =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as { delegationId?: unknown }).delegationId
        : undefined;
    if (typeof delegationId === "string" && delegationId) {
      callByDelegationId.set(delegationId, toolCallId);
    }
    const args = message.toolArgs;
    const resume =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as { resume?: unknown }).resume
        : undefined;
    const prior =
      typeof resume === "string" && resume.trim()
        ? callByDelegationId.get(resume.trim())
        : undefined;
    if (prior) childOf.set(prior, toolCallId);
  }
  const latest = new Map<string, string>();
  return (toolCallId: string): string => {
    const cached = latest.get(toolCallId);
    if (cached) return cached;
    let current = toolCallId;
    const seen = new Set<string>([current]);
    for (;;) {
      const next = childOf.get(current);
      if (!next || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    latest.set(toolCallId, current);
    return current;
  };
}

/**
 * Group provider-level assistant fragments and tool rows into user-level turns.
 * Providers end an assistant message before each tool call, but that transport
 * boundary is not a separate conversational response.
 *
 * `compactions` (oldest first) each produce a divider row right after the
 * message they cover, mirroring how the runtime splices its checkpoint entry
 * after the same anchor. A mark whose anchor is no longer in the transcript —
 * rewritten, forked away — has nowhere to sit and is dropped.
 */
export function buildTranscriptEntries(
  messages: UiMessage[],
  compactions: readonly ContextCompactionMark[] = [],
): {
  entries: TranscriptEntry[];
  visible: UiMessage[];
} {
  const runs = collectSubagentRuns(messages);
  // Delegate rows are not transcript rows of their own: they hang off their
  // `Task` call, so they stay out of the turn stream and the minimap.
  const visible = messages.filter(
    (message) => !message.parentToolCallId && isVisibleMessage(message),
  );
  const anchored = new Map<string, ContextCompactionMark[]>();
  for (const mark of compactions) {
    const marks = anchored.get(mark.throughMessageId);
    if (marks) marks.push(mark);
    else anchored.set(mark.throughMessageId, [mark]);
  }
  const entries: TranscriptEntry[] = [];
  let turn: AssistantTurnEntry | undefined;
  let turnStartedAt: string | undefined;

  const ensureTurn = (message: UiMessage) => {
    if (turn) return turn;
    turn = {
      kind: "assistant-turn",
      id: message.id,
      ...(turnStartedAt ? { startedAt: turnStartedAt } : {}),
      parts: [],
    };
    entries.push(turn);
    return turn;
  };

  const pushActivity = (item: AssistantActivityItem) => {
    const current = ensureTurn(item.message);
    const last = current.parts[current.parts.length - 1];
    // A delegation card is only the Task fan-out. Mixing the parent's later
    // Read/Grep/thinking into that group painted them as subagent work (D319).
    if (
      last?.kind === "activity" &&
      last.items.length > 0 &&
      isDelegationStartActivity(last.items[0]) === isDelegationStartActivity(item)
    ) {
      last.items.push(item);
      return;
    }
    current.parts.push({ kind: "activity", items: [item] });
  };

  const appendMessage = (message: UiMessage) => {
    if (message.role === "user" || message.role === "system") {
      turn = undefined;
      turnStartedAt = message.role === "user" ? message.createdAt : undefined;
      entries.push({ kind: "message", message });
      return;
    }

    if (message.role === "tool") {
      const delegate = message.toolCallId
        ? runs.get(message.toolCallId)
        : undefined;
      pushActivity({
        kind: "tool",
        message,
        ...(delegate ? { delegate } : {}),
      });
      return;
    }

    const current = ensureTurn(message);
    const thinking = messageThinking(message);
    if (thinking) pushActivity({ kind: "thinking", message });
    if ((message.content || "").trim() || !thinking || message.error) {
      current.parts.push({ kind: "message", message });
      if (!current.anchorId && (message.content || "").trim()) {
        current.anchorId = message.id;
      }
    }
  };

  for (const message of visible) {
    appendMessage(message);
    const marks = anchored.get(message.id);
    if (!marks) continue;
    // The row is a divider, so whatever turn it lands inside ends there and the
    // next assistant fragment opens a new one.
    turn = undefined;
    for (const mark of marks) entries.push({ kind: "compaction", mark });
  }

  for (const entry of entries) {
    if (entry.kind !== "assistant-turn") continue;
    for (let index = 0; index < entry.parts.length; index += 1) {
      const part = entry.parts[index];
      const next = entry.parts[index + 1];
      if (
        part.kind === "activity" &&
        next?.kind === "message" &&
        !part.items.some((item) => item.message.id === next.message.id)
      ) {
        part.endedAt = next.message.createdAt;
      }
    }
  }

  return { entries, visible };
}

/**
 * Whether two delegate runs render the same rows.
 *
 * `buildTranscriptEntries` rebuilds run objects on every message change, so
 * memoized activity groups cannot compare them by identity; without this a
 * delegate's rows would either never update or re-render on every tick.
 */
export function subagentRunsEqual(
  previous: SubagentRun | undefined,
  next: SubagentRun | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (
    previous.agentName !== next.agentName ||
    previous.items.length !== next.items.length
  ) {
    return false;
  }
  return previous.items.every(
    (item, index) =>
      item.kind === next.items[index].kind &&
      item.message === next.items[index].message,
  );
}

export function reuseReadonlyMap<K, V>(
  previous: ReadonlyMap<K, V> | undefined,
  next: ReadonlyMap<K, V>,
  valuesEqual: (left: V, right: V) => boolean = Object.is,
): ReadonlyMap<K, V> {
  if (!previous || previous.size !== next.size) return next;
  for (const [key, value] of next) {
    if (!previous.has(key) || !valuesEqual(previous.get(key) as V, value)) {
      return next;
    }
  }
  return previous;
}

function reuseActivityItem(
  previous: AssistantActivityItem | undefined,
  next: AssistantActivityItem,
): AssistantActivityItem {
  if (!previous || previous.kind !== next.kind || previous.message !== next.message) {
    return next;
  }
  if (previous.kind === "tool" && next.kind === "tool") {
    if (subagentRunsEqual(previous.delegate, next.delegate)) return previous;
    if (!next.delegate || !previous.delegate) return next;
    const items = next.delegate.items.map((item, index) => {
      const prior = previous.delegate?.items[index];
      return prior && prior.kind === item.kind && prior.message === item.message
        ? prior
        : item;
    });
    const delegate =
      previous.delegate.agentName === next.delegate.agentName &&
      previous.delegate.items.length === items.length &&
      items.every((item, index) => item === previous.delegate!.items[index])
        ? previous.delegate
        : { ...next.delegate, items };
    return delegate === previous.delegate ? previous : { ...next, delegate };
  }
  return previous;
}

function reuseTurnPart(
  previous: AssistantTurnPart | undefined,
  next: AssistantTurnPart,
): AssistantTurnPart {
  if (!previous || previous.kind !== next.kind) return next;
  if (previous.kind === "message" && next.kind === "message") {
    return previous.message === next.message ? previous : next;
  }
  if (previous.kind === "activity" && next.kind === "activity") {
    if (previous.endedAt !== next.endedAt) {
      const items = next.items.map((item, index) =>
        reuseActivityItem(previous.items[index], item),
      );
      return { ...next, items };
    }
    const items = next.items.map((item, index) =>
      reuseActivityItem(previous.items[index], item),
    );
    if (
      items.length === previous.items.length &&
      items.every((item, index) => item === previous.items[index])
    ) {
      return previous;
    }
    return { ...next, items };
  }
  return next;
}

function reuseTranscriptEntry(
  previous: TranscriptEntry | undefined,
  next: TranscriptEntry,
): TranscriptEntry {
  if (!previous || previous.kind !== next.kind) return next;
  if (previous.kind === "message" && next.kind === "message") {
    return previous.message === next.message ? previous : next;
  }
  if (previous.kind === "compaction" && next.kind === "compaction") {
    return previous.mark === next.mark ||
      (previous.mark.id === next.mark.id &&
        previous.mark.throughMessageId === next.mark.throughMessageId &&
        previous.mark.generation === next.mark.generation &&
        previous.mark.summaryTokens === next.mark.summaryTokens &&
        previous.mark.summarized === next.mark.summarized &&
        previous.mark.fallback === next.mark.fallback)
      ? previous
      : next;
  }
  if (previous.kind === "assistant-turn" && next.kind === "assistant-turn") {
    if (previous.id !== next.id) return next;
    const parts = next.parts.map((part, index) =>
      reuseTurnPart(previous.parts[index], part),
    );
    if (
      previous.anchorId === next.anchorId &&
      parts.length === previous.parts.length &&
      parts.every((part, index) => part === previous.parts[index])
    ) {
      return previous;
    }
    return { ...next, parts };
  }
  return next;
}

/**
 * Keep object identity for unchanged transcript rows so memoized activity
 * groups can bail out when only the live tail token changed.
 */
export function reuseTranscriptEntries(
  previous: readonly TranscriptEntry[] | undefined,
  next: TranscriptEntry[],
): TranscriptEntry[] {
  if (!previous || previous.length === 0) return next;
  const shared = next.map((entry, index) =>
    reuseTranscriptEntry(previous[index], entry),
  );
  if (
    shared.length === previous.length &&
    shared.every((entry, index) => entry === previous[index])
  ) {
    return previous as TranscriptEntry[];
  }
  return shared;
}

export function assistantTurnMessages(
  entry: AssistantTurnEntry,
): UiMessage[] {
  return entry.parts.flatMap((part) =>
    part.kind === "message" ? [part.message] : [],
  );
}

/**
 * Every message of the turn that the model streamed, in transcript order,
 * whether it arrived as a message part or as an activity row.
 *
 * `assistantTurnMessages` only sees the message parts, and a reply that
 * streamed thinking without content is pushed as an activity item alone. The
 * turn's timing questions ("how long until the first token", "when did it
 * finish") are about the stream, not about the parts, so they have to read the
 * activity rows too. A fragment that carries both thinking and content appears
 * in both places, so the set is deduplicated by message id.
 */
export function assistantTurnStreamedMessages(
  entry: AssistantTurnEntry,
): UiMessage[] {
  const seen = new Set<string>();
  const messages: UiMessage[] = [];
  const push = (message: UiMessage) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    messages.push(message);
  };
  for (const part of entry.parts) {
    if (part.kind === "message") {
      push(part.message);
      continue;
    }
    for (const item of part.items) push(item.message);
  }
  return messages;
}

/**
 * The turn's own model rows: the streamed set without the tool results that
 * share those activity items. Usage and estimate questions are about what the
 * model reported for the turn, and only an assistant row carries that.
 */
function assistantTurnAssistantMessages(entry: AssistantTurnEntry): UiMessage[] {
  return assistantTurnStreamedMessages(entry).filter(
    (message) => message.role === "assistant",
  );
}

/**
 * The rows these entries actually render, in transcript order.
 *
 * The minimap resolves a click by finding the marker's `data-minimap-id` node in
 * the scroller, so it must be built from the mounted entries rather than from
 * every loaded message (D261). Fed the full set while the transcript window
 * withholds older rows, it would draw dashes whose click target does not exist
 * and jump nowhere.
 */
export function transcriptEntryMessages(
  entries: readonly TranscriptEntry[],
): UiMessage[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "message") return [entry.message];
    if (entry.kind === "assistant-turn") return assistantTurnMessages(entry);
    return [];
  });
}

export function assistantTurnTools(entry: AssistantTurnEntry): UiMessage[] {
  return entry.parts.flatMap((part) =>
    part.kind === "activity"
      ? part.items.flatMap((item) =>
          item.kind === "tool" ? [item.message] : [],
        )
      : [],
  );
}

export function assistantTurnResponseDuration(
  entry: AssistantTurnEntry,
): number | undefined {
  // Every streamed fragment counts, including a thinking-only one that never
  // reached the message parts.
  const durations = assistantTurnStreamedMessages(entry).flatMap((message) =>
    typeof message.responseDurationMs === "number" &&
    Number.isFinite(message.responseDurationMs) &&
    message.responseDurationMs > 0
      ? [message.responseDurationMs]
      : [],
  );
  if (durations.length === 0) return undefined;
  return durations.reduce((total, duration) => total + duration, 0);
}

/** First-token latency measured for the turn's first streamed reply (D447). */
export function assistantTurnResponseFirstToken(
  entry: AssistantTurnEntry,
): number | undefined {
  // The turn's *first* stream carries this latency, and that stream may have
  // been thinking-only — so the activity rows are read too, in transcript
  // order, before falling through to a later post-tool answer.
  for (const message of assistantTurnStreamedMessages(entry)) {
    const value = message.responseFirstTokenMs;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * When the turn's final assistant stream ended: the row's own start plus the
 * stream duration it recorded, so the footer can print a completion time
 * without a second timestamp crossing the wire.
 */
export function assistantTurnCompletedAt(
  entry: AssistantTurnEntry,
): string | undefined {
  const messages = assistantTurnStreamedMessages(entry);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const duration = messages[index].responseDurationMs;
    if (typeof duration !== "number" || !Number.isFinite(duration)) continue;
    const startedAt = Date.parse(messages[index].createdAt);
    if (!Number.isFinite(startedAt)) continue;
    return new Date(startedAt + Math.max(0, duration)).toISOString();
  }
  return undefined;
}

export function assistantTurnResponseOutputTokens(
  entry: AssistantTurnEntry,
): number | undefined {
  const counts = assistantTurnAssistantMessages(entry).flatMap((message) => {
    // A provider can report zero output for a stream the runtime still
    // summarized (an interrupted one). `??` would keep that zero and drop the
    // summary, which is the only count the turn has left, so the reported value
    // only wins when it is a positive number.
    const reported = message.usage?.outputTokens;
    const value =
      typeof reported === "number" && Number.isFinite(reported) && reported > 0
        ? reported
        : message.responseOutputTokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? [value]
      : [];
  });
  if (counts.length === 0) return undefined;
  return counts.reduce((total, count) => total + count, 0);
}

export function assistantTurnResponseOutputIsEstimated(
  entry: AssistantTurnEntry,
): boolean {
  return assistantTurnAssistantMessages(entry).some(
    (message) =>
      (!message.usage || message.usage.outputTokens <= 0) &&
      typeof message.responseOutputTokens === "number" &&
      message.responseOutputTokens > 0,
  );
}

export function assistantTurnContent(entry: AssistantTurnEntry): string {
  return assistantTurnMessages(entry)
    .map((message) => (message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function assistantTurnUsage(
  entry: AssistantTurnEntry,
): MessageUsage | undefined {
  const usages = assistantTurnAssistantMessages(entry).flatMap((message) =>
    message.usage ? [message.usage] : [],
  );
  if (usages.length === 0) return undefined;

  const sum = (field: keyof MessageUsage) =>
    usages.reduce((total, usage) => total + (usage[field] ?? 0), 0);
  const optionalSum = (
    field: "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens",
  ) =>
    usages.some((usage) => usage[field] !== undefined) ? sum(field) : undefined;
  const cacheReadTokens = optionalSum("cacheReadTokens");
  const cacheWriteTokens = optionalSum("cacheWriteTokens");
  const reasoningTokens = optionalSum("reasoningTokens");

  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}
