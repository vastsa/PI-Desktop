/**
 * The retained tail a *failed* compaction installs, and the shape marker that
 * tells a later rebuild to replay it verbatim.
 *
 * A successful checkpoint summarizes the whole range behind its boundary and
 * retains at most the latest user message (`codexShapedPreparation`). A
 * retained-tail fallback has no fresh summary at all, so its tail is the only
 * thing carrying the range forward — and a single user sentence left the model
 * with none of the decisions, paths, or unfinished work of the turn it was
 * continuing (issue #827, which is ADR 0049's "recent provider-valid message
 * tail" read literally).
 *
 * The fallback therefore retains the real recent window: the newest contiguous
 * run of messages in the compacted range, every role, under a token budget, and
 * marks the checkpoint with {@link COMPACTION_RETAINED_TAIL_SHAPE} so a restored
 * checkpoint replays that window instead of narrowing it back to one user
 * message (see `retainedTailForContext`). Records written before the marker
 * existed keep the old one-user-message normalization.
 *
 * Deliberately dependency-light, like `context-budget.ts`: token estimation is
 * pi-agent-core's, the record guard and the text bounding are the shared
 * helpers, and nothing here imports `runtime.ts`, so this module can never form
 * a cycle with it.
 */

import {
  estimateTokens,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { isRecord, truncateMessageText } from "./agent-messages.js";

/**
 * `details` marker for a tail holding the real recent window rather than the
 * one-user-message list older checkpoints stored.
 */
export const COMPACTION_RETAINED_TAIL_SHAPE = "recent_window";

/** Appended when one message alone exceeds the tail budget. */
export const CHECKPOINT_TRUNCATION_MARKER =
  "\n\n[checkpoint truncated: this message crossed the retained context budget]\n\n";

/**
 * Roles a retained tail may carry. Anything else in the range is skipped: a
 * tail is replayed straight into the model context, so only messages the
 * runtime produced belong in it.
 */
const RETAINED_TAIL_ROLES = new Set(["user", "assistant", "toolResult"]);

/** Assistant stop reasons pi drops from the rebuilt model context. */
const DROPPED_STOP_REASONS = new Set(["error", "aborted", "deferred"]);

function messageTokens(message: AgentMessage): number {
  return Math.max(1, Math.ceil(estimateTokens(message)));
}

/**
 * Bound one message to a token budget by truncating its text blocks. Tool calls
 * and tool results keep their identity, so a truncated message is still a
 * provider-valid message.
 */
export function truncateMessageToTail(
  message: AgentMessage,
  maxTokens: number,
): AgentMessage {
  return truncateMessageText(
    message,
    Math.max(64, Math.floor(Math.max(1, maxTokens)) * 4),
    CHECKPOINT_TRUNCATION_MARKER,
  );
}

/** Content blocks of a message, whatever shape its role uses. */
function contentBlocks(message: AgentMessage): unknown[] {
  const content: unknown = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/** Tool-call ids produced by the assistant messages of `messages`. */
function assistantToolCallIds(messages: AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of contentBlocks(message)) {
      if (!isRecord(block)) continue;
      const { type, id } = block;
      if (type === "toolCall" && typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/**
 * Drop tool results whose tool call is not in `messages`. pi removes errored,
 * aborted, and deferred assistant messages from the rebuilt context, taking
 * their tool calls with them, and a provider rejects a result whose call is
 * missing — so the tail cannot keep a result the window no longer explains.
 */
function pruneOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
  const owned = assistantToolCallIds(messages);
  return messages.filter(
    (message) =>
      message.role !== "toolResult" ||
      (typeof message.toolCallId === "string" && owned.has(message.toolCallId)),
  );
}

/** pi keeps an assistant message only when its stop reason is replayable. */
function isReplayableAssistant(message: AgentMessage): boolean {
  if (message.role !== "assistant") return true;
  return !DROPPED_STOP_REASONS.has(
    (message as { stopReason?: string }).stopReason ?? "",
  );
}

/** Whether a persisted value is a message a tail can replay. */
export function isRetainedTailMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  if (typeof value.role !== "string" || !RETAINED_TAIL_ROLES.has(value.role)) {
    return false;
  }
  if (typeof value.content !== "string" && !Array.isArray(value.content)) {
    return false;
  }
  if (value.role === "toolResult") return typeof value.toolCallId === "string";
  return true;
}

/**
 * Replay a persisted tail. Structural validation is not cosmetic: a record is
 * opaque JSON by the time it comes back from the host, and a malformed entry
 * would reach the provider as a context message.
 */
export function replayRetainedTail(value: unknown): AgentMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value.filter(isRetainedTailMessage).map((message) => {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    return typeof timestamp === "number" && Number.isFinite(timestamp)
      ? message
      : ({ ...message, timestamp: 0 } as AgentMessage);
  });
  return pruneOrphanToolResults(messages.filter(isReplayableAssistant));
}

function findLatestUserIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isRetainedTailMessage(message)) return index;
  }
  return -1;
}

/**
 * Strip the tool calls of an assistant message. Only the last-resort single
 * message needs this: an assistant whose results are not retained cannot keep
 * the calls they answer, or the provider rejects the context.
 */
export function stripDanglingToolCalls(message: AgentMessage): AgentMessage {
  const blocks = contentBlocks(message);
  if (
    message.role !== "assistant" ||
    blocks.length === 0 ||
    !blocks.some((block) => isRecord(block) && block.type === "toolCall")
  ) {
    return message;
  }
  const content = blocks.filter(
    (block) => !(isRecord(block) && block.type === "toolCall"),
  );
  return { ...message, content } as AgentMessage;
}
/**
 * The message a last-resort tail carries. A provider accepts neither a tool
 * result nor an unanswered tool call on its own, so this is a user message or
 * assistant text; `latestUserGoal` decides which one comes first.
 */
function soleReplayableMessage(
  messages: AgentMessage[],
  options: { latestUserGoal?: boolean },
): AgentMessage | undefined {
  const roles: AgentMessage["role"][] = options.latestUserGoal
    ? ["user", "assistant"]
    : ["assistant", "user"];
  for (const role of roles) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role !== role || !isReplayableAssistant(message)) continue;
      return role === "assistant" ? stripDanglingToolCalls(message) : message;
    }
  }
  return undefined;
}

/**
 * The newest contiguous run of `messages` that fits `maxTokens`.
 *
 * Always retains the newest replayable message — truncating it when one message
 * alone exceeds the budget — so a fallback can never install an empty tail.
 * With `latestUserGoal` (an `active_turn` fallback) the active task's user
 * message is kept as well, ahead of the window, because the point of the tail is
 * that the provider can continue the turn it was in the middle of.
 */
export function selectRecentTail(
  messages: AgentMessage[],
  maxTokens: number,
  options: { latestUserGoal?: boolean } = {},
): AgentMessage[] {
  const budget = Math.max(1, Math.floor(maxTokens));
  let start = messages.length;
  let tokens = 0;
  while (start > 0) {
    const candidate = messages[start - 1]!;
    if (!isRetainedTailMessage(candidate) || !isReplayableAssistant(candidate)) {
      start -= 1;
      continue;
    }
    const cost = messageTokens(candidate);
    // The newest message is always kept; every older one has to fit.
    if (tokens + cost > budget && start < messages.length) break;
    tokens += cost;
    start -= 1;
  }

  let window = messages
    .slice(start)
    .filter(isRetainedTailMessage)
    .filter(isReplayableAssistant);
  if (options.latestUserGoal && !window.some((message) => message.role === "user")) {
    const latestUserIndex = findLatestUserIndex(messages);
    if (latestUserIndex >= 0) {
      window = [
        truncateMessageToTail(
          messages[latestUserIndex]!,
          Math.floor(budget / 2),
        ),
        ...window,
      ];
    }
  }
  const tail = pruneOrphanToolResults(
    window.map((message) =>
      messageTokens(message) > budget
        ? truncateMessageToTail(message, budget)
        : message,
    ),
  );
  if (tail.length > 0) return tail;
  // A truncated window can prune down to nothing when its only message was a
  // tool result whose call fell outside the budget. The checkpoint still has to
  // restore something the provider accepts, so keep one message of its own.
  const solo = soleReplayableMessage(messages, options);
  return solo ? [truncateMessageToTail(solo, budget)] : [];
}
