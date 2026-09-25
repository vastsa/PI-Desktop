/**
 * A delegate's own context budget: turn-boundary compaction, degradation, and
 * the terminal overflow a parent can act on (ADR 0299, decisions 2-6).
 *
 * The session compacts through durable checkpoints owned by host-core; a
 * delegate compacts only its in-memory model context for the duration of its
 * run (ADR 0299, Consequences). Nothing in this module writes to host-core,
 * the transcript, or the parent's context: the input is the delegate agent's
 * message list, and the output is the replacement list the run installs.
 *
 * The budget formula is the shared one from `context-budget.ts`, evaluated
 * against the model the run actually resolved — a definition's `maxTokens`
 * pin included — so a delegate never gets a looser boundary than its parent
 * would compute for the same model.
 */

import {
  BACKGROUND_CONTEXT,
  createCompactionSummaryMessage,
  generateSummaryWithUsage,
  prepareCompaction,
  withAbortSignal,
  type AgentMessage,
  type CompactionSettings,
  type CompactionSummaryMessage,
  type Entry,
  type MessageEntry,
  type PrepareNextTurnContext,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  Model,
  Models,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  automaticCompactionThresholdFor,
  contextBudgetFor,
  contextBudgetLimitsFor,
  retainedUserMessageBudget,
  type ContextBudget,
  type ContextBudgetModel,
  type ContextBudgetModelInput,
} from "./context-budget.js";
import {
  estimateOutputCapInputTokens,
  type OutputCapContext,
  type OutputCapReplayTarget,
} from "./output-cap.js";
import {
  COMPACTION_SUMMARY_RETRY_POLICY,
  estimateSummaryPromptTokens,
  reduceSummaryInput,
  type CompactionSummaryInput,
} from "./compaction-summary-input.js";
import { withCompactionRequestHeaders } from "./compaction-request.js";
import {
  DEFAULT_MAX_TOKENS,
  createProviderModels,
  type RuntimeProviderConfig,
} from "./provider-binding.js";

/**
 * Safety margin between the summary prompt and the model window. The session
 * applies the same 2 048-token reserve; the constant is local because
 * `runtime.ts` owns its private copy and importing the runtime would cycle.
 */
const DELEGATE_SUMMARY_PROMPT_SAFETY_TOKENS = 2_048;

/** Marker replacing the elided middle of a retained delegate task brief. */
const DELEGATE_RETENTION_TRUNCATION_MARKER =
  "\n\n[delegate context truncated: this message crossed the retained context budget]\n\n";

/** Which side of a turn boundary the delegate sits on (ADR 0136's rule). */
export type DelegateRetentionMode = "active_turn" | "completed_turn";

/**
 * A boundary with pending tool results retains the active turn's instruction;
 * a completed turn carries no naked historical user message into what follows.
 */
export function delegateRetentionMode(
  turn: PrepareNextTurnContext,
): DelegateRetentionMode {
  return (turn.toolResults?.length ?? 0) > 0 ||
    turn.message?.stopReason === "toolUse"
    ? "active_turn"
    : "completed_turn";
}

/** What a delegate turn boundary decided about the next request's context. */
export type DelegateTurnUpdate =
  | { kind: "unchanged" }
  | {
      kind: "compacted";
      messages: AgentMessage[];
      tokensBefore: number;
      summaryUsage?: Usage;
    }
  | { kind: "degraded"; messages: AgentMessage[]; tokensBefore: number }
  | { kind: "overflow"; tokens: number; hardLimit: number };

/**
 * The terminal failure the parent model can act on (ADR 0299, decision 5):
 * not the provider's raw overflow sentence, but the three changes that would
 * actually let a retry succeed.
 */
export function subagentContextOverflowError(modelId: string): {
  code: "SUBAGENT_CONTEXT_OVERFLOW";
  message: string;
} {
  return {
    code: "SUBAGENT_CONTEXT_OVERFLOW",
    message:
      `The delegated task does not fit in the context window of model "${modelId}", even after compaction and history reduction. ` +
      "Narrow the task, delegate to a model with a larger context window, or make the delegate read less at once.",
  };
}

/**
 * Build the provider registry a delegate summary request goes through, with
 * the same header seam the session's compaction uses: pi-agent-core hands the
 * collection to its own request path, so provider and session headers have to
 * ride on it.
 */
export function delegateSummaryModels(
  provider: RuntimeProviderConfig,
  model: Model<Api>,
  sessionId: string,
): Models {
  return withCompactionRequestHeaders(
    createProviderModels(provider, model),
    provider,
    sessionId,
  );
}

/**
 * Decide the context for a delegate's next provider request. Below the shared
 * 90% automatic trigger nothing changes; at or above it the run compacts
 * synchronously, then degrades, and only then reports the hard-limit overflow
 * its caller turns into `SUBAGENT_CONTEXT_OVERFLOW`.
 */
export async function prepareDelegateTurnContext(input: {
  /** The delegate agent's current in-memory messages. */
  messages: AgentMessage[];
  /** The model whose resolved output cap defines this request's hard limit. */
  model: Model<Api>;
  /** New text the next provider request will append after any checkpoint. */
  additionalMessages?: AgentMessage[];
  /** Provider-visible prompt/tool overhead, separate from transcript rows. */
  systemPrompt?: string;
  tools?: unknown[];
  /** The delegated instruction, kept verbatim through degradation. */
  taskBrief: string;
  retentionMode: DelegateRetentionMode;
  /** Built lazily: a boundary below the limit never pays for a registry. */
  summaryModels: () => Models;
  thinkingLevel?: ThinkingLevel;
  signal: AbortSignal;
  /** False when `Agent.prompt(taskBrief)` will append the task after preflight. */
  retainTaskBriefOnDegradation?: boolean;
}): Promise<DelegateTurnUpdate> {
  const additionalMessages = input.additionalMessages ?? [];
  const budget = delegateContextBudgetFor(
    input.model,
    input.messages,
    additionalMessages,
    input.systemPrompt,
    input.tools,
  );
  if (budget.tokens < automaticCompactionThresholdFor(budget)) {
    return { kind: "unchanged" };
  }
  // With no history there is nothing to compact; if the complete next request
  // still fits the hard budget, do not manufacture a lossy checkpoint.
  if (input.messages.length === 0 && budget.tokens < budget.hardLimit) {
    return { kind: "unchanged" };
  }

  const compacted = await compactDelegateContext(input, budget);
  if (compacted) {
    const fit = delegateContextBudgetFor(
      input.model,
      compacted.messages,
      additionalMessages,
      input.systemPrompt,
      input.tools,
    );
    if (fit.tokens < fit.hardLimit) {
      return { kind: "compacted", ...compacted };
    }
  }

  const degraded = degradedDelegateMessages(
    input.messages,
    input.taskBrief,
    input.model,
    {
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      additionalMessages,
      includeTaskBrief: input.retainTaskBriefOnDegradation !== false,
    },
  );
  if (degraded) {
    const fit = delegateContextBudgetFor(
      input.model,
      degraded,
      additionalMessages,
      input.systemPrompt,
      input.tools,
    );
    if (fit.tokens < fit.hardLimit) {
      return { kind: "degraded", messages: degraded, tokensBefore: budget.tokens };
    }
  }
  return { kind: "overflow", tokens: budget.tokens, hardLimit: budget.hardLimit };
}

function outputCapContextMessages(
  messages: AgentMessage[],
): OutputCapContext["messages"] {
  return messages.filter(
    (message): message is Extract<AgentMessage, { content: unknown }> =>
      "content" in message,
  );
}

function outputCapReplayTarget(
  model: ContextBudgetModelInput,
): OutputCapReplayTarget | undefined {
  if (!("api" in model)) return undefined;
  return { api: model.api, provider: model.provider, id: model.id };
}

function delegateContextBudgetFor(
  model: Model<Api>,
  messages: AgentMessage[],
  additionalMessages: AgentMessage[] = [],
  systemPrompt?: string,
  tools?: unknown[],
): ContextBudget {
  const requestMessages = [...messages, ...additionalMessages];
  const estimate = contextBudgetFor(model, requestMessages);
  const requestTokens = estimateOutputCapInputTokens(
    {
      messages: outputCapContextMessages(requestMessages),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(tools !== undefined ? { tools } : {}),
    },
    outputCapReplayTarget(model),
  );
  return { ...estimate, tokens: Math.max(estimate.tokens, requestTokens) };
}

/**
 * Compact through pi-agent-core's primitives, shaped the way the session's
 * checkpoint is shaped: pi's three contiguous ranges are summarized as one,
 * and the retained tail is rebuilt from the retention mode rather than pi's
 * token cut, so no tool call can be orphaned from its result. Returns
 * undefined when no summary could be produced — the caller degrades instead.
 */
async function compactDelegateContext(
  input: {
    messages: AgentMessage[];
    model: Model<Api>;
    retentionMode: DelegateRetentionMode;
    summaryModels: () => Models;
    thinkingLevel?: ThinkingLevel;
    signal: AbortSignal;
  },
  budget: ContextBudget,
): Promise<
  { messages: AgentMessage[]; tokensBefore: number; summaryUsage?: Usage } | undefined
> {
  // A prior in-memory compaction left its summary message at the head; it
  // threads into the next summary as `previousSummary` instead of being
  // summarized a second time.
  const head = input.messages[0];
  const previousSummary = isCompactionSummary(head) ? head.summary : undefined;
  const compactable =
    previousSummary === undefined ? input.messages : input.messages.slice(1);
  const prepared = prepareCompaction(delegateMessageEntries(compactable), {
    enabled: true,
    reserveTokens: budget.requestHeadroom,
    keepRecentTokens: budget.keepRecentTokens,
  } satisfies CompactionSettings);
  if (!prepared.ok || !prepared.value) return undefined;
  const messagesToSummarize = [
    ...prepared.value.messagesToSummarize,
    ...prepared.value.turnPrefixMessages,
    ...prepared.value.retainedTail,
  ];
  if (messagesToSummarize.length === 0) return undefined;

  let summaryInput: CompactionSummaryInput = {
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    previousSummary,
  };
  // The summary request itself must fit the window; shrink it one bounded
  // step the way the session does, then give up to the degradation path.
  if (delegateSummaryInputExceedsBudget(summaryInput, input.model, budget)) {
    const reduced = reduceSummaryInput(summaryInput);
    if (
      !reduced ||
      delegateSummaryInputExceedsBudget(reduced, input.model, budget)
    ) {
      return undefined;
    }
    summaryInput = reduced;
  }

  const result = await generateSummaryWithUsage(
    summaryInput.messagesToSummarize,
    input.summaryModels(),
    input.model,
    budget.requestHeadroom,
    undefined,
    summaryInput.previousSummary,
    input.thinkingLevel,
    COMPACTION_SUMMARY_RETRY_POLICY,
    undefined,
    withAbortSignal(input.signal, BACKGROUND_CONTEXT),
  );
  if (!result.ok) {
    if (result.error.code === "aborted" || input.signal.aborted) {
      // A stop that landed mid-summary is an abort, not a compaction failure.
      throw new Error("Turn aborted while compacting context");
    }
    return undefined;
  }
  return {
    messages: [
      createCompactionSummaryMessage(
        result.value.text,
        prepared.value.tokensBefore,
        Date.now(),
      ),
      ...retainedDelegateTail(
        messagesToSummarize,
        input.retentionMode,
        budget,
      ),
    ],
    tokensBefore: prepared.value.tokensBefore,
    summaryUsage: result.value.usage,
  };
}

/**
 * The degraded context (ADR 0299, decision 4): the original task brief plus
 * the most recent message(s) that still fit, everything older discarded.
 * Returns undefined when even the brief alone crosses the hard limit — the
 * terminal case its caller reports as `SUBAGENT_CONTEXT_OVERFLOW`.
 *
 * Sizing uses the per-message character estimate rather than
 * `estimateContextTokens`: a kept assistant message carries the usage block of
 * the request that produced it, which describes the pre-degradation context
 * and would condemn every rebuilt context to still look oversized.
 */
export type DelegateDegradationOptions = {
  systemPrompt?: string;
  tools?: unknown[];
  additionalMessages?: AgentMessage[];
  /** Omit a task brief that will be appended through `Agent.prompt()` next. */
  includeTaskBrief?: boolean;
};

export function degradedDelegateMessages(
  messages: AgentMessage[],
  taskBrief: string,
  model: ContextBudgetModelInput,
  options: DelegateDegradationOptions = {},
): AgentMessage[] | undefined {
  const limits = contextBudgetLimitsFor(model);
  const briefIndex = messages.findIndex((message) => message.role === "user");
  const brief: UserMessage | undefined =
    briefIndex >= 0
      ? (messages[briefIndex] as UserMessage)
      : options.includeTaskBrief === false
        ? undefined
        : { role: "user", content: taskBrief, timestamp: Date.now() };
  const requestOverhead = estimateOutputCapInputTokens(
    {
      messages: outputCapContextMessages(options.additionalMessages ?? []),
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    },
    outputCapReplayTarget(model),
  );
  const briefTokens = brief
    ? estimateOutputCapInputTokens(
        { messages: outputCapContextMessages([brief]) },
        outputCapReplayTarget(model),
      )
    : 0;
  const hardLimit = limits.hardLimit;
  let tokens = briefTokens + requestOverhead;
  if (tokens >= hardLimit) return undefined;

  const pool = messages.slice(briefIndex >= 0 ? briefIndex + 1 : 0);
  const suffix: AgentMessage[] = [];
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    const message = pool[index];
    if (!isDelegateContextMessage(message)) continue;
    const cost = estimateOutputCapInputTokens(
      { messages: [message] },
      outputCapReplayTarget(model),
    );
    if (tokens + cost >= hardLimit) break;
    suffix.unshift(message);
    tokens += cost;
  }
  // Tool results are contiguous with the assistant that requested them, so a
  // suffix cut can only start inside that pair on the result side. Dropping
  // leading results keeps the pair rule intact: no result reaches a provider
  // without its call, and no call without its results.
  while (suffix[0]?.role === "toolResult") suffix.shift();
  return [...(brief ? [brief] : []), ...suffix];
}

/**
 * The retained tail of a delegate compaction. An active turn keeps only the
 * latest user message — for a delegate, the task brief — truncated rather
 * than dropped when it alone crosses the retention budget (the session's
 * newest-first selection degenerates to exactly this for one candidate).
 */
function retainedDelegateTail(
  messages: AgentMessage[],
  mode: DelegateRetentionMode,
  budget: ContextBudget,
): AgentMessage[] {
  if (mode !== "active_turn") return [];
  const latestUser = messages
    .filter((message): message is UserMessage => message.role === "user")
    .at(-1);
  if (!latestUser) return [];
  return [
    truncateDelegateUserMessage(latestUser, retainedUserMessageBudget(budget)),
  ];
}

function truncateDelegateUserMessage(
  message: UserMessage,
  tokenBudget: number,
): UserMessage {
  const text = delegateUserMessageText(message);
  const maxChars = Math.max(1, tokenBudget) * 4;
  if (text.length <= maxChars) return message;
  if (maxChars <= DELEGATE_RETENTION_TRUNCATION_MARKER.length) {
    return {
      ...message,
      content: DELEGATE_RETENTION_TRUNCATION_MARKER.trim().slice(0, maxChars),
    };
  }
  const retainedChars = maxChars - DELEGATE_RETENTION_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(retainedChars * 0.75);
  const tailChars = retainedChars - headChars;
  return {
    ...message,
    content: `${text.slice(0, headChars)}${DELEGATE_RETENTION_TRUNCATION_MARKER}${
      tailChars > 0 ? text.slice(-tailChars) : ""
    }`,
  };
}

/** Flatten a user message the way the session's checkpoint truncation does. */
function delegateUserMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[${block.type} content omitted from checkpoint]`,
    )
    .join("\n");
}

/** The summary prompt must fit beside the model's own output budget. */
function delegateSummaryInputExceedsBudget(
  input: CompactionSummaryInput,
  model: Model<Api>,
  budget: ContextBudget,
): boolean {
  const contextWindow = budget.hardLimit + budget.requestHeadroom;
  const modelOutputBudget = Math.min(
    Math.floor(budget.requestHeadroom * 0.8),
    Math.max(1, Math.round(model.maxTokens || DEFAULT_MAX_TOKENS)),
  );
  const limit = Math.max(
    1,
    contextWindow - modelOutputBudget - DELEGATE_SUMMARY_PROMPT_SAFETY_TOKENS,
  );
  return estimateSummaryPromptTokens(input) > limit;
}

/**
 * Synthetic message-entry chain for `prepareCompaction`. A delegate has no
 * durable entry log, so the cut point is computed over its in-memory messages
 * wrapped in the entry shape pi's compaction expects.
 */
function delegateMessageEntries(messages: AgentMessage[]): Entry[] {
  let parentId: string | null = null;
  return messages.map((message, index) => {
    const id = `delegate-context-${index}`;
    const entry: MessageEntry = {
      type: "message",
      id,
      parentId,
      seq: index,
      timestamp: messageTimestamp(message),
      message,
    };
    parentId = id;
    return entry;
  });
}

function messageTimestamp(message: AgentMessage): number {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : Date.now();
}

function isCompactionSummary(
  message: AgentMessage | undefined,
): message is CompactionSummaryMessage {
  return message?.role === "compactionSummary";
}

/** Failed, aborted, and empty assistants are transcript rows, not context. */
/** Failed, aborted, and empty assistants are transcript rows, not context. */
function isDelegateContextMessage(
  message: AgentMessage,
): message is Extract<AgentMessage, { content: unknown }> {
  return (
    "content" in message &&
    (message.role !== "assistant" ||
      (message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        message.stopReason !== "deferred" &&
        message.content.length > 0))
  );
}
