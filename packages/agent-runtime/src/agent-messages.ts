/**
 * Message helpers shared by the session runtime and its subagents.
 *
 * Both loops read pi-ai assistant content and usage into the same `UiMessage`
 * shape, so the conversions live here instead of being duplicated per loop.
 */

import type { AgentMessage, JsonValue } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { MessageUsage, UsageProvenance } from "@pi-desktop/shared";

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

/** Pi requires numeric costs, including when replaying history with no price. */
export type AccountedPiUsage = Usage & { desktopUsage?: MessageUsage };

export function usageFromPi(
  usage: Usage | undefined | null,
  provenance: UsageProvenance = {},
): MessageUsage | undefined {
  if (!usage) return undefined;
  const retained = (usage as AccountedPiUsage).desktopUsage;
  if (retained) return { ...retained, ...provenance };
  const tokens = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
  const inputTokens = tokens(usage.input);
  const outputTokens = tokens(usage.output);
  const cacheReadTokens = tokens(usage.cacheRead);
  const cacheWriteTokens = tokens(usage.cacheWrite);
  const reasoningTokens = typeof usage.reasoning === "number" ? tokens(usage.reasoning) : undefined;
  const totalTokens = tokens(usage.totalTokens) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const validCost = usage.cost && (["input", "output", "cacheRead", "cacheWrite", "total"] as const).every((key) => Number.isFinite(usage.cost[key]) && usage.cost[key] >= 0);
  // Pi adapters normally calculate cost from model rates. Unmarked all-zero
  // costs are also their missing-price placeholder, not evidence of free use.
  const costStatus = provenance.costStatus ?? (validCost && usage.cost.total > 0 ? "estimated" : "unknown");
  const cost = validCost && costStatus !== "unknown" ? { ...usage.cost } : undefined;
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0 && !cost?.total) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens,
    usageOrigin: "pi",
    ...provenance,
    costStatus: cost ? costStatus : "unknown",
    ...(cost ? { cost } : {}),
    ...(provenance.operationId ? { aggregation: "operation" } : {}),
  };
}

export function usageToPi(usage: MessageUsage | undefined): AccountedPiUsage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(usage?.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
    totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: usage?.cost && usage.costStatus !== "unknown"
      ? { ...usage.cost }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    // Explicitly tag the numeric placeholder so it can never become a known
    // zero-dollar charge when reconstructed history crosses this boundary again.
    ...(usage ? { desktopUsage: { ...usage } } : {}),
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
