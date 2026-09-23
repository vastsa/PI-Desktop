/**
 * Message helpers shared by the session runtime and its subagents.
 *
 * Both loops read pi-ai assistant content and usage into the same `UiMessage`
 * shape, so the conversions live here instead of being duplicated per loop.
 */

import type { AgentMessage, JsonValue } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { MessageUsage } from "@pi-desktop/shared";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Epoch milliseconds for a pi session entry. pi 0.84 changed `Entry.timestamp`
 * from an ISO string to a number, so entries we synthesize from stored history
 * need the numeric form. */
export function timestampMs(timestamp: unknown): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-clone an opaque value so it satisfies pi 0.86 `JsonValue`. */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}
export function toJsonObject(value: unknown): Record<string, JsonValue> {
  const normalized = toJsonValue(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : {};
}

export function usageFromPi(
  usage: Usage | undefined | null,
): MessageUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = Math.max(0, Math.round(usage.input || 0));
  const outputTokens = Math.max(0, Math.round(usage.output || 0));
  const cacheReadTokens = Math.max(0, Math.round(usage.cacheRead || 0));
  const cacheWriteTokens = Math.max(0, Math.round(usage.cacheWrite || 0));
  const reasoningTokens =
    typeof usage.reasoning === "number"
      ? Math.max(0, Math.round(usage.reasoning))
      : undefined;
  const totalTokens = Math.max(
    0,
    Math.round(
      usage.totalTokens ||
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ),
  );
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens,
  };
}

export function usageToPi(usage: MessageUsage | undefined): Usage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(usage?.reasoningTokens !== undefined
      ? { reasoning: usage.reasoningTokens }
      : {}),
    totalTokens:
      usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export type AssistantContent = {
  text: string;
  thinking: string;
  hasText: boolean;
  hasThinking: boolean;
};

/** Flatten a pi-ai assistant content array into visible text and reasoning. */
export function assistantContent(content: unknown): AssistantContent {
  if (typeof content === "string") {
    return { text: content, thinking: "", hasText: true, hasThinking: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", thinking: "", hasText: false, hasThinking: false };
  }

  let text = "";
  let thinking = "";
  let hasText = false;
  let hasThinking = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as {
      type?: string;
      text?: string;
      thinking?: string;
    };
    if (block.type === "text" && typeof block.text === "string") {
      hasText = true;
      text += block.text;
    } else if (block.type === "thinking") {
      hasThinking = true;
      if (typeof block.thinking === "string") {
        thinking += block.thinking;
      } else if (typeof block.text === "string") {
        // Accept OpenAI-compatible adapters that expose thinking as `text`.
        thinking += block.text;
      }
    }
  }
  return { text, thinking, hasText, hasThinking };
}

/**
 * Bound `text` to `maxChars`, keeping both ends and naming the cut in the
 * middle. Compaction uses this wherever a message has to fit a budget it
 * cannot: the survived text stays readable and the marker says why it is
 * shorter.
 */
export function truncateTextWithMarker(
  text: string,
  maxChars: number,
  marker: string,
): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return marker.trim().slice(0, maxChars);
  const retainedChars = maxChars - marker.length;
  const headChars = Math.ceil(retainedChars * 0.75);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${marker}${
    tailChars > 0 ? text.slice(-tailChars) : ""
  }`;
}

/**
 * Bound every text block of one message so the message's total text is at most
 * `maxChars`. Blocks without text (tool calls, images) are kept, so a truncated
 * message is still a provider-valid message with its tool calls intact.
 */
export function truncateMessageText(
  message: AgentMessage,
  maxChars: number,
  marker: string,
): AgentMessage {
  const content: unknown = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const text = truncateTextWithMarker(content, maxChars, marker);
    return text === content ? message : ({ ...message, content: text } as AgentMessage);
  }
  if (!Array.isArray(content)) return message;
  let remaining = maxChars;
  let changed = false;
  const blocks = content.map((block) => {
    if (!isRecord(block) || typeof block.text !== "string") return block;
    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      return block;
    }
    changed = true;
    const text = truncateTextWithMarker(block.text, Math.max(1, remaining), marker);
    remaining = 0;
    return { ...block, text };
  });
  return changed ? ({ ...message, content: blocks } as AgentMessage) : message;
}
