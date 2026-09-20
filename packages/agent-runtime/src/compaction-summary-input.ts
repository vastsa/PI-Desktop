import {
  convertToLlm,
  serializeConversation,
  type AgentMessage,
  type CompactionPreparation,
} from "@earendil-works/pi-agent-core";
import type { RetryPolicy } from "@earendil-works/pi-ai";

/**
 * Sizing and retry policy for the automatic summary request (ADR 0282).
 *
 * pi-agent-core serializes the messages it summarizes into one text prompt and
 * caps every tool result at 2 000 characters while doing so. The runtime's
 * budget guard used to add up `estimateTokens` over the raw messages instead,
 * so a session whose bulk was tool output looked several times larger than the
 * prompt it would actually send and was routed to retained-tail recovery
 * without ever asking the model (issue #543). These helpers size the prompt the
 * way pi builds it, and shrink the input one bounded step before giving up.
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

export type CompactionSummaryInput = Pick<
  CompactionPreparation,
  "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary"
>;

/**
 * Tokens the summary request(s) will carry for this input, using pi's own
 * serialization and the four-characters-per-token heuristic the rest of the
 * runtime uses. A split turn issues two requests (history, then turn prefix);
 * the larger one is the one that has to fit.
 */
export function estimateSummaryPromptTokens(input: CompactionSummaryInput): number {
  const historyChars =
    serializeConversation(convertToLlm(input.messagesToSummarize)).length +
    (input.previousSummary?.length ?? 0);
  const turnPrefixChars =
    input.isSplitTurn && input.turnPrefixMessages.length > 0
      ? serializeConversation(convertToLlm(input.turnPrefixMessages)).length
      : 0;
  return Math.ceil(Math.max(historyChars, turnPrefixChars) / 4);
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
