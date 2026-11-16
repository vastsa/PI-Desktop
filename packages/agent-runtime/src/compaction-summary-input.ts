import {
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { truncateMessageText } from "./agent-messages.js";
import {
  charBudgetWithinOutputCap,
  estimateOutputCapInputTokens,
} from "./output-cap.js";
import { ESTIMATED_TEXT_CHARS_PER_TOKEN } from "./pi-runtime-estimates.js";
import { convertToLlm, serializeConversation } from "./pi-runtime-messages.js";
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
 * way the adapter sends it and shrink the input one bounded step — when
 * even that does not fit, they split the range into chunks that each do, so the
 * budget decides how many requests a summary takes rather than whether the
 * model is asked at all (issue #827). The size is chars/3.5 of that serialized
 * text plus the output-cap CJK correction. chars/3.5 alone treats Han as about
 * a third of a token, so a prompt that overflows the model was sent whole.
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
 * Share of a chunk's budget the planner fills. Each message is sized on its
 * own, while a chunk is one serialized text joined by blank lines, so the
 * margin keeps that joined request inside the window it was planned for.
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
 * chars/4 baseline inside {@link estimateOutputCapInputTokens}. Kept here so
 * the CJK correction can be moved onto the chars/3.5 summary baseline without
 * importing output-cap's private constants.
 */
const OUTPUT_CAP_CHARS_PER_TOKEN = 4;
/** What output-cap adds per CJK character on top of chars/4 (1 - 0.25). */
const OUTPUT_CAP_CJK_SHORTFALL = 0.75;

/**
 * Token estimate for text that is already the summary prompt pi will send.
 *
 * ASCII stays on `ceil(chars / 3.5)`, the ratio this guard has always used.
 * Replacing that with the output-cap total would shrink every English prompt
 * by 12.5% and reopen the reserve/guard gap. Han, kana, and Hangul are topped
 * up with output-cap's CJK correction, scaled by the shortfall chars/3.5 has
 * not already charged, so one CJK character lands near one token.
 */
function estimatePromptTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const baseline = Math.ceil(text.length / ESTIMATED_TEXT_CHARS_PER_TOKEN);
  const outputCapBaseline = Math.ceil(text.length / OUTPUT_CAP_CHARS_PER_TOKEN);
  const outputCap = estimateOutputCapInputTokens({
    messages: [{ role: "user", content: text }],
  });
  const cjkCorrection = outputCap - outputCapBaseline;
  if (cjkCorrection <= 0) return baseline;
  const remainingShortfall = 1 - 1 / ESTIMATED_TEXT_CHARS_PER_TOKEN;
  return (
    baseline +
    Math.ceil((cjkCorrection * remainingShortfall) / OUTPUT_CAP_CJK_SHORTFALL)
  );
}

/**
 * Tokens the summary request(s) will carry for this input, using pi's own
 * serialization. A split turn issues two requests (history, then turn prefix);
 * the larger estimate is the one that has to fit. Previous-summary text is
 * counted on the history request, in the same units as the serialized messages.
 */
export function estimateSummaryPromptTokens(input: CompactionSummaryInput): number {
  const history =
    serializeConversation(convertToLlm(input.messagesToSummarize)) +
    (input.previousSummary ?? "");
  const turnPrefix =
    input.isSplitTurn && input.turnPrefixMessages.length > 0
      ? serializeConversation(convertToLlm(input.turnPrefixMessages))
      : "";
  return Math.max(
    estimatePromptTextTokens(history),
    estimatePromptTextTokens(turnPrefix),
  );
}

/** Serialized size of one message, in the same units as the summary guard. */
function summaryMessageTokens(message: AgentMessage): number {
  return Math.max(
    1,
    estimateSummaryPromptTokens({
      messagesToSummarize: [message],
      turnPrefixMessages: [],
      isSplitTurn: false,
    }),
  );
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
 * than the model's output budget. The carried text is measured with
 * {@link estimatePromptTextTokens}, the same estimate as
 * {@link estimateSummaryPromptTokens}. Reserving it at four characters per
 * token, or at chars/3.5 when the summary is CJK, under-counts the guard, and
 * the chunk margin applies only to what remains, so the first chunk can leave
 * the window it was planned for.
 */
export function compactionSummaryReserveTokens(input: {
  previousSummary?: string;
  outputBudget: number;
}): number {
  return Math.max(
    estimatePromptTextTokens(input.previousSummary ?? ""),
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
    const cost = summaryMessageTokens(message);
    if (current.length > 0 && tokens + cost > budget) {
      chunks.push(current);
      if (chunks.length >= COMPACTION_SUMMARY_MAX_CHUNKS) return undefined;
      current = [];
      tokens = 0;
    }
    current.push(cost > budget ? truncateSummaryMessage(message, budget) : message);
    tokens += Math.min(cost, budget);
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : undefined;
}

/**
 * Cut one message so the serialized summary prompt fits `tokenBudget`.
 *
 * The character ceiling is the historical ASCII cap (`budget * 3.5`). Latin
 * text already estimates under it, so the length stays. CJK text estimates
 * near one token per character, and {@link charBudgetWithinOutputCap} walks
 * the cut down until the output-cap estimate of the serialized prompt fits.
 * `budget * 3.5` characters of Han would still overflow that budget.
 */
function truncateSummaryMessage(
  message: AgentMessage,
  tokenBudget: number,
): AgentMessage {
  const ceiling = Math.max(
    1,
    Math.floor(Math.max(1, tokenBudget) * ESTIMATED_TEXT_CHARS_PER_TOKEN),
  );
  const maxChars = charBudgetWithinOutputCap(tokenBudget, ceiling, (chars) =>
    serializeConversation(
      convertToLlm([
        truncateMessageText(message, chars, SUMMARY_CHUNK_TRUNCATION_MARKER),
      ]),
    ),
  );
  return truncateMessageText(message, maxChars, SUMMARY_CHUNK_TRUNCATION_MARKER);
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
