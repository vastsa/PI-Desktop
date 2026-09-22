/**
 * Preserve DeepSeek-compatible reasoning across context compaction (#296).
 *
 * Codex-shaped checkpoints drop assistant turns (and their thinking) from the
 * retained tail so tool calls cannot strand. Strict relays still require a
 * non-empty reasoning field on later assistant messages. Stashing the last few
 * thinking turns in opaque checkpoint `details.retainedReasoning` and replaying
 * them as text-only assistants after the summary keeps usable reasoning without
 * reintroducing tool-call pairs or multiple user prompts (ADR 0136 / D275).
 *
 * Replayed assistants must carry the live request's api/provider/model: pi-ai
 * `transformMessages` converts thinking to plain text when the assistant is from
 * a different model, which would drop reasoning_* on the wire.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

/** Cap how many pre-compaction thinking turns ride inside the checkpoint. */
export const MAX_RETAINED_REASONING_TURNS = 3;

/** Per-field character budget so a checkpoint cannot balloon on one long think. */
export const MAX_RETAINED_REASONING_FIELD_CHARS = 4_000;

/**
 * Non-empty content stand-in for thinking-only retained turns. convertMessages
 * drops assistants with empty/whitespace-only text after mapping thinking to
 * reasoning_*, so a trimmed non-empty body is required for the reasoning field
 * to reach the wire (#296).
 */
export const RETAINED_REASONING_CONTENT_STANDIN = ".";

/** Sentinel provider/model until the live request identity is applied. */
export const RETAINED_REASONING_PROVIDER = "compaction-reasoning-replay";
export const RETAINED_REASONING_MODEL = "compaction-reasoning-replay";

const COMPLETIONS_REASONING_SIGNATURES = new Set([
  "reasoning_content",
  "reasoning_text",
  "reasoning",
]);

export type ReasoningReplayIdentity = {
  api: AssistantMessage["api"];
  provider: string;
  model: string;
  /** Only compatible Completions requests need synthetic reasoning replay. */
  requiresCompletionsReasoningReplay?: boolean;
};

export type RetainedReasoningTurn = {
  thinking: string;
  text: string;
  /** Live Completions field name when known; defaults to reasoning_content. */
  thinkingSignature?: string;
  /** Source assistant identity so transformMessages keeps thinking blocks. */
  api?: AssistantMessage["api"];
  provider?: string;
  model?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateField(value: string): string {
  if (value.length <= MAX_RETAINED_REASONING_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_RETAINED_REASONING_FIELD_CHARS)}…`;
}

function normalizeThinkingSignature(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return COMPLETIONS_REASONING_SIGNATURES.has(trimmed) ? trimmed : undefined;
}

function assistantThinkingText(message: AssistantMessage): {
  thinking: string;
  text: string;
  thinkingSignature?: string;
} {
  const thinking: string[] = [];
  const text: string[] = [];
  let thinkingSignature: string | undefined;
  for (const block of message.content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const value = block.thinking.trim();
      if (value) {
        thinking.push(value);
        if (!thinkingSignature) {
          thinkingSignature = normalizeThinkingSignature(block.thinkingSignature);
        }
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const value = block.text.trim();
      if (value) text.push(value);
    }
  }
  return {
    thinking: thinking.join("\n"),
    text: text.join("\n"),
    ...(thinkingSignature ? { thinkingSignature } : {}),
  };
}

/**
 * Collect the newest assistant turns that still carry thinking, newest-last,
 * for storage in checkpoint details. Tool-call blocks are dropped on purpose.
 */
export function harvestRetainedReasoning(
  messages: readonly AgentMessage[],
  limit = MAX_RETAINED_REASONING_TURNS,
): RetainedReasoningTurn[] {
  const selected: RetainedReasoningTurn[] = [];
  for (let index = messages.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    const parts = assistantThinkingText(assistant);
    if (!parts.thinking) continue;
    selected.push({
      thinking: truncateField(parts.thinking),
      text: truncateField(parts.text),
      ...(parts.thinkingSignature
        ? { thinkingSignature: parts.thinkingSignature }
        : {}),
      ...(typeof assistant.api === "string" ? { api: assistant.api } : {}),
      ...(typeof assistant.provider === "string" && assistant.provider
        ? { provider: assistant.provider }
        : {}),
      ...(typeof assistant.model === "string" && assistant.model
        ? { model: assistant.model }
        : {}),
    });
  }
  return selected.reverse();
}

/** Read `details.retainedReasoning` from a checkpoint without trusting shape. */
export function retainedReasoningFromDetails(
  details: unknown,
): RetainedReasoningTurn[] {
  if (!isRecord(details) || !Array.isArray(details.retainedReasoning)) return [];
  const turns: RetainedReasoningTurn[] = [];
  for (const entry of details.retainedReasoning) {
    if (!isRecord(entry)) continue;
    if (typeof entry.thinking !== "string" || !entry.thinking.trim()) continue;
    const thinkingSignature = normalizeThinkingSignature(entry.thinkingSignature);
    turns.push({
      thinking: truncateField(entry.thinking.trim()),
      text:
        typeof entry.text === "string" && entry.text.trim()
          ? truncateField(entry.text.trim())
          : "",
      ...(thinkingSignature ? { thinkingSignature } : {}),
      ...(typeof entry.api === "string" ? { api: entry.api as AssistantMessage["api"] } : {}),
      ...(typeof entry.provider === "string" && entry.provider
        ? { provider: entry.provider }
        : {}),
      ...(typeof entry.model === "string" && entry.model
        ? { model: entry.model }
        : {}),
    });
    if (turns.length >= MAX_RETAINED_REASONING_TURNS) break;
  }
  return turns;
}

function resolveIdentity(
  turn: RetainedReasoningTurn,
  identity?: ReasoningReplayIdentity,
): ReasoningReplayIdentity {
  if (identity) return identity;
  if (turn.api && turn.provider && turn.model) {
    return { api: turn.api, provider: turn.provider, model: turn.model };
  }
  return {
    api: "openai-completions",
    provider: RETAINED_REASONING_PROVIDER,
    model: RETAINED_REASONING_MODEL,
  };
}

/**
 * Rebuild text-only assistant messages that convertMessages can map back to
 * `reasoning_*`. Prefer the live thinkingSignature when known; otherwise stamp
 * `reasoning_content`. Thinking-only turns get a non-empty content stand-in so
 * convertMessages does not drop them after mapping. Pass `identity` matching the
 * upcoming Completions request so transformMessages keeps thinking blocks.
 */
export function retainedReasoningToMessages(
  turns: readonly RetainedReasoningTurn[],
  timestamp: number,
  identity?: ReasoningReplayIdentity,
): AssistantMessage[] {
  return turns.map((turn, index) => {
    const signature =
      normalizeThinkingSignature(turn.thinkingSignature) ?? "reasoning_content";
    const visibleText = turn.text.trim()
      ? turn.text
      : RETAINED_REASONING_CONTENT_STANDIN;
    const resolved = resolveIdentity(turn, identity);
    const content: AssistantMessage["content"] = [
      {
        type: "thinking",
        thinking: turn.thinking,
        thinkingSignature: signature,
      },
      { type: "text", text: visibleText },
    ];
    return {
      role: "assistant",
      content,
      api: resolved.api,
      provider: resolved.provider,
      model: resolved.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: timestamp + index,
    } as AssistantMessage;
  });
}

/**
 * Rewrite sentinel retained-reasoning assistants so they match the live model.
 * pi-ai transformMessages only preserves thinking blocks for same-model replay.
 */
export function alignRetainedReasoningIdentity(
  messages: readonly Message[],
  identity: ReasoningReplayIdentity,
): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const assistant = message as AssistantMessage;
    if (assistant.provider !== RETAINED_REASONING_PROVIDER) return message;
    return {
      ...assistant,
      api: identity.api,
      provider: identity.provider,
      model: identity.model,
    } as AssistantMessage;
  });
}
