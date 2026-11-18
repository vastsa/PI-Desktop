import {
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { truncateMessageText } from "./agent-messages.js";
import {
  ESTIMATED_TEXT_CHARS_PER_TOKEN,
  estimateTokens,
} from "./pi-runtime-estimates.js";
import { convertToLlm, serializeConversation } from "./pi-runtime-messages.js";
import { countCjkChars } from "./output-cap.js";
import type { CompactionPreparation } from "./pi-runtime-types.js";
import { DEFAULT_MAX_TOKENS } from "./provider-binding.js";

/**
 * Sizing and retry policy for the automatic summary request (ADR 0282).
 *
 * The desktop summary adapter serializes messages into one text prompt and
 * caps every tool result at 2 000 characters. The budget guard used to add up
 * `estimateTokens` over the raw messages instead,
 * so a session whose bulk was tool output looked several times larger than the
 * prompt it would actually send and was routed to retained-tail recovery
 * without ever asking the model (issue #543). These helpers size the prompt the
 * the way the adapter sends it and shrink the input one bounded step — when
 * even that does not fit, they split the range into chunks that each do, so the
 * budget decides how many requests a summary takes rather than whether the
 * model is asked at all (issue #827).
 */

/**
 * Retries after the first failed summary request. pi-ai only retries responses
 * its classifier calls transient (overload, 5xx, dropped streams, timeouts);
 * quota, auth, and malformed-request failures return on the first attempt.
 * Waits are 2s, 4s, 8s, so a flapping provider costs at most ~14s of extra
 * wall clock before the retained-tail fallback runs.
 */
export const COMPACTION_SUMMARY_MAX_RETRIES = 3;
export const COMPACTION_SUMMARY_RETRY_BASE_MS = 2_000;

export const COMPACTION_SUMMARY_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: COMPACTION_SUMMARY_MAX_RETRIES,
  baseDelayMs: COMPACTION_SUMMARY_RETRY_BASE_MS,
};

/**
 * Per-tool-result character cap on the reduced input. pi already caps at 2 000
 * when serializing; the reduced pass keeps a prefix a quarter of that so the
 * model still sees what each call returned without the bulk.
 */
export const COMPACTION_REDUCED_TOOL_RESULT_CHARS = 500;

const REDUCED_TOOL_RESULT_SUFFIX = "\n\n[... tool output truncated for the summary request]";
/**
 * Tokens held back from the window for the summary prompt template itself, on
 * top of the model's own output allowance. The preflight guard and the chunk
 * planner both subtract it, so their budgets cannot disagree.
 */
export const COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS = 2_048;
/**
 * Upper bound on the summary requests one checkpoint may issue. A range needing
 * more than this is not a compaction any more; it falls back.
 */
export const COMPACTION_SUMMARY_MAX_CHUNKS = 16;
/**
 * Share of a chunk's budget the planner fills. A chunk is sized from
 * `estimateTokens`, while the request carries pi's serialized form — per-message
 * role labels and separators the raw estimate does not count — so the margin
 * keeps every planned request inside the window it was planned for.
 */
export const COMPACTION_SUMMARY_CHUNK_MARGIN = 0.9;
/** Appended when a single message alone exceeds one chunk's budget. */
export const SUMMARY_CHUNK_TRUNCATION_MARKER =
  "\n\n[message truncated: the summary request budget could not carry it whole]";

export type CompactionSummaryInput = Pick<
  CompactionPreparation,
  "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary"
>;

/**
 * CJK-aware token estimate of one serialized prompt string: the chars/3.5
 * baseline pi's text estimator uses, plus the shortfall the baseline charges
 * CJK text — Han, kana, and Hangul tokenize at ~1 token per character while
 * the baseline bills them 1/3.5, so 0.75 tokens per CJK character are added
 * back (issue #2364). A CJK prompt that looks like it fits at chars/3.5 is
 * otherwise sent whole and rejected as a context overflow.
 */
export function estimatePromptTextTokens(text: string): number {
  return (
    Math.ceil(text.length / ESTIMATED_TEXT_CHARS_PER_TOKEN) +
    Math.ceil(countCjkChars(text) * 0.75)
  );
}

/** CJK characters carried by one message's text-bearing content blocks. */
function messageCjkChars(message: AgentMessage): number {
  const content: unknown = (message as { content?: unknown }).content;
  if (typeof content === "string") return countCjkChars(content);
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; [key: string]: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      count += countCjkChars(record.text);
    } else if (record.type === "thinking" && typeof record.thinking === "string") {
      count += countCjkChars(record.thinking);
    } else if (
      (record.type === "toolCall" || record.type === "functionCall") &&
      typeof record.name === "string"
    ) {
      // JSON.stringify leaves Han unescaped, so the arguments the provider
      // receives carry the same characters the correction has to charge.
      const payload = (() => {
        try {
          const serialized = JSON.stringify(record.arguments ?? record.input);
          return serialized === undefined ? "" : serialized;
        } catch {
          return "";
        }
      })();
      count += countCjkChars(record.name) + countCjkChars(payload);
    }
  }
  return count;
}

/** Per-message chunk cost: pi's estimator plus the CJK shortfall it ignores. */
function estimateChunkMessageTokens(message: AgentMessage): number {
  return (
    Math.ceil(estimateTokens(message)) +
    Math.ceil(messageCjkChars(message) * 0.75)
  );
}

/**
 * Tokens the summary request(s) will carry for this input, using pi's own
 * serialization and text-token estimate. A split turn issues two requests
 * (history, then turn prefix);
 * the larger one is the one that has to fit.
 */
export function estimateSummaryPromptTokens(input: CompactionSummaryInput): number {
  const history =
    serializeConversation(convertToLlm(input.messagesToSummarize)) +
    (input.previousSummary ?? "");
  const turnPrefix =
    input.isSplitTurn && input.turnPrefixMessages.length > 0
      ? serializeConversation(convertToLlm(input.turnPrefixMessages))
      : "";
  return Math.max(estimatePromptTextTokens(history), estimatePromptTextTokens(turnPrefix));
}

/**
 * One bounded reduction of the summary input: tool results keep a short prefix
 * and assistant thinking is dropped. User text, assistant text, and tool call
 * arguments survive intact, so the summary still covers every message the
 * checkpoint will file behind its boundary. Returns undefined when nothing was
 * reducible, so the caller can fall back without a pointless second request.
 */
export function reduceSummaryInput<T extends CompactionSummaryInput>(
  input: T,
): T | undefined {
  let changed = false;
  const reduce = (messages: AgentMessage[]) =>
    messages.map((message) => {
      const reduced = reduceMessage(message);
      if (reduced !== message) changed = true;
      return reduced;
    });
  const messagesToSummarize = reduce(input.messagesToSummarize);
  const turnPrefixMessages = reduce(input.turnPrefixMessages);
  if (!changed) return undefined;
  return { ...input, messagesToSummarize, turnPrefixMessages };
}

function reduceMessage(message: AgentMessage): AgentMessage {
  if (message.role === "toolResult") {
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      const text = boundToolResultText(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });
    return changed ? { ...message, content } : message;
  }
  if (message.role === "assistant") {
    if (!message.content.some((block) => block.type === "thinking")) return message;
    return {
      ...message,
      content: message.content.filter((block) => block.type !== "thinking"),
    };
  }
  return message;
}

function boundToolResultText(text: string): string {
  if (text.length <= COMPACTION_REDUCED_TOOL_RESULT_CHARS) return text;
  return text.slice(0, COMPACTION_REDUCED_TOOL_RESULT_CHARS) + REDUCED_TOOL_RESULT_SUFFIX;
}

/**
 * Output allowance one summary request gets: the smaller of 80% of the request
 * headroom and the model's own output budget. pi makes the same computation
 * when it caps the summary request, so the chunk planner and the guard agree.
 */
export function compactionSummaryOutputBudget(input: {
  requestHeadroom: number;
  modelMaxTokens?: number;
}): number {
  return Math.min(
    Math.floor(input.requestHeadroom * 0.8),
    Math.max(1, Math.round(input.modelMaxTokens || DEFAULT_MAX_TOKENS)),
  );
}

/**
 * Tokens the summary prompt may carry inside this window. A prompt at or above
 * it cannot be sent with room for the summary itself, so the guard rejects it —
 * and the chunk planner splits the range so every chunk stays below it.
 */
export function compactionSummaryInputLimit(input: {
  hardLimit: number;
  requestHeadroom: number;
  modelMaxTokens?: number;
}): number {
  return Math.max(
    1,
    input.hardLimit +
      input.requestHeadroom -
      compactionSummaryOutputBudget(input) -
      COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS,
  );
}

/**
 * Room one chunk keeps for the summary its prompt carries. The first chunk
 * carries `previousSummary`; every later chunk carries a summary no larger
 * than the model's output budget. The carried text is measured with the same
 * character estimate as {@link estimateSummaryPromptTokens}. Reserving it at
 * four characters per token under-counts the guard by 12.5%, and the chunk
 * margin applies only to what remains, so the first chunk can leave the window
 * it was planned for.
 */
export function compactionSummaryReserveTokens(input: {
  previousSummary?: string;
  outputBudget: number;
}): number {
  return Math.max(
    input.previousSummary
      ? estimatePromptTextTokens(input.previousSummary)
      : 0,
    input.outputBudget,
  );
}

/**
 * Split a summary input into contiguous chunks that each fit the request
 * budget, so a range too large for one prompt is still summarized instead of
 * skipped (issue #827).
 *
 * Every chunk is summarized by its own request and each request carries the
 * summary of the chunk before it — pi's update-the-summary prompt — so the chain
 * ends on one summary covering the whole range. `reserveTokens` is the room the
 * running summary and the previous summary may take in a chunk's prompt.
 *
 * Returns undefined when the range cannot be split: it is empty, or it would
 * need more than {@link COMPACTION_SUMMARY_MAX_CHUNKS} requests. A single
 * message larger than the budget is truncated rather than dropped, so no message
 * ever leaves the summary's scope.
 */
/**
 * Largest character budget that keeps a truncated message inside the chunk's
 * token budget. Plain ASCII keeps the chars/3.5 cap; a CJK-bearing message is
 * cut further by binary search so the truncated text still meets the same
 * CJK-aware estimate the guard and the planner use (issue #2364).
 */
function chunkTruncationChars(message: AgentMessage, budgetTokens: number): number {
  const asciiCap = Math.floor(budgetTokens * ESTIMATED_TEXT_CHARS_PER_TOKEN);
  if (messageCjkChars(message) === 0) return asciiCap;
  let lo = 0;
  let hi = asciiCap;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    const truncated = truncateMessageText(
      message,
      mid,
      SUMMARY_CHUNK_TRUNCATION_MARKER,
    );
    if (estimateChunkMessageTokens(truncated) <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function planSummaryChunks(
  input: CompactionSummaryInput,
  options: { summaryInputLimit: number; reserveTokens: number },
): AgentMessage[][] | undefined {
  const range = [
    ...input.messagesToSummarize,
    ...(input.isSplitTurn ? input.turnPrefixMessages : []),
  ];
  if (range.length === 0) return undefined;
  const budget = Math.max(
    1,
    Math.floor(
      (options.summaryInputLimit - Math.max(0, options.reserveTokens)) *
        COMPACTION_SUMMARY_CHUNK_MARGIN,
    ),
  );
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let tokens = 0;
  for (const message of range) {
    const cost = Math.max(1, estimateChunkMessageTokens(message));
    if (current.length > 0 && tokens + cost > budget) {
      chunks.push(current);
      if (chunks.length >= COMPACTION_SUMMARY_MAX_CHUNKS) return undefined;
      current = [];
      tokens = 0;
    }
    current.push(
      cost > budget
        ? truncateMessageText(
            message,
            chunkTruncationChars(message, budget),
            SUMMARY_CHUNK_TRUNCATION_MARKER,
          )
        : message,
    );
    tokens += Math.min(cost, budget);
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : undefined;
}

/**
 * Sum the provider usage of the requests that produced one summary. pi reports
 * one usage object per request and a chunked summary spends several, so the
 * checkpoint — and the cost the context inspector shows — carries the total of
 * the requests the summary actually took.
 */
export function addSummaryUsage(
  total: Usage | undefined,
  next: Usage | undefined,
): Usage | undefined {
  if (!next) return total;
  if (!total) return next;
  const cacheWrite1h = total.cacheWrite1h ?? next.cacheWrite1h;
  const reasoning = total.reasoning ?? next.reasoning;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    ...(reasoning === undefined
      ? {}
      : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: (total.cost?.input ?? 0) + (next.cost?.input ?? 0),
      output: (total.cost?.output ?? 0) + (next.cost?.output ?? 0),
      cacheRead: (total.cost?.cacheRead ?? 0) + (next.cost?.cacheRead ?? 0),
      cacheWrite: (total.cost?.cacheWrite ?? 0) + (next.cost?.cacheWrite ?? 0),
      total: (total.cost?.total ?? 0) + (next.cost?.total ?? 0),
    },
  };
}
