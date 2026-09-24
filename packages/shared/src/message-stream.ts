/**
 * Streaming message updates: delta application, wire slimming, and merge.
 *
 * `message_start` / `message_end` still carry a full `UiMessage`. High-frequency
 * `message_update` events on the append-only path carry `stream: "delta"` and
 * omit growing `content` / `thinking` so serialization stays O(chunk).
 */

import type { AgentEvent, AgentEventEnvelope, UiMessage } from "./types.js";

export const STREAM_COALESCE_INTERVAL_MS = 16;

export type MessageUpdateEvent = Extract<AgentEvent, { type: "message_update" }>;

export function isDeltaStreamUpdate(
  event: AgentEvent,
): event is MessageUpdateEvent {
  return event.type === "message_update" && event.stream === "delta";
}

/** Suffix (or replacement) of a cumulative provider string. */
export function cumulativeDelta(
  previous: string,
  next: string,
): { delta: string; reset: boolean } {
  if (next === previous) return { delta: "", reset: false };
  if (next.startsWith(previous)) {
    return { delta: next.slice(previous.length), reset: false };
  }
  return { delta: next, reset: true };
}

/** Identity fields for a streaming row; growing text lives in deltas. */
export function streamingMessageIdentity(message: UiMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    content: "",
    createdAt: message.createdAt,
    status: message.status,
    ...(message.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: message.timeToFirstTokenMs } : {}),
    ...(message.modelId ? { modelId: message.modelId } : {}),
    ...(message.providerId ? { providerId: message.providerId } : {}),
    ...(message.parentToolCallId
      ? { parentToolCallId: message.parentToolCallId }
      : {}),
    ...(message.agentName ? { agentName: message.agentName } : {}),
    ...(message.hostedSearch ? { hostedSearch: message.hostedSearch } : {}),
  };
}

export function hasMessageUpdateDeltas(event: MessageUpdateEvent): boolean {
  return (
    event.stream === "delta" ||
    event.deltaText !== undefined ||
    event.deltaThinking !== undefined ||
    event.resetText === true ||
    event.resetThinking === true
  );
}

/** Slim an in-memory snapshot+delta update for the cross-process path. */
export function toWireMessageUpdate(event: MessageUpdateEvent): MessageUpdateEvent {
  if (event.stream === "delta") return event;
  if (!hasMessageUpdateDeltas(event)) return event;
  return {
    type: "message_update",
    stream: "delta",
    message: streamingMessageIdentity(event.message),
    ...(event.deltaText ? { deltaText: event.deltaText } : {}),
    ...(event.deltaThinking ? { deltaThinking: event.deltaThinking } : {}),
    ...(event.resetText ? { resetText: true } : {}),
    ...(event.resetThinking ? { resetThinking: true } : {}),
  };
}

function mergeDeltaField(
  previousReset: boolean | undefined,
  previousDelta: string | undefined,
  nextReset: boolean | undefined,
  nextDelta: string | undefined,
): { reset: boolean; delta: string } {
  if (nextReset) return { reset: true, delta: nextDelta ?? "" };
  if (previousReset) {
    return { reset: true, delta: `${previousDelta ?? ""}${nextDelta ?? ""}` };
  }
  return { reset: false, delta: `${previousDelta ?? ""}${nextDelta ?? ""}` };
}

/** Concatenate two streaming updates for the same message id. */
export function mergeMessageUpdates(
  previous: MessageUpdateEvent,
  next: MessageUpdateEvent,
): MessageUpdateEvent {
  if (!hasMessageUpdateDeltas(next)) return next;
  if (!hasMessageUpdateDeltas(previous)) {
    return {
      type: "message_update",
      message: applyMessageUpdate(previous.message, next),
    };
  }
  const text = mergeDeltaField(
    previous.resetText,
    previous.deltaText,
    next.resetText,
    next.deltaText,
  );
  const thinking = mergeDeltaField(
    previous.resetThinking,
    previous.deltaThinking,
    next.resetThinking,
    next.deltaThinking,
  );
  return {
    type: "message_update",
    message: next.message,
    ...(previous.stream === "delta" || next.stream === "delta"
      ? { stream: "delta" as const }
      : {}),
    ...(text.delta ? { deltaText: text.delta } : {}),
    ...(thinking.delta ? { deltaThinking: thinking.delta } : {}),
    ...(text.reset ? { resetText: true } : {}),
    ...(thinking.reset ? { resetThinking: true } : {}),
  };
}

export function mergeAgentEventEnvelopes(
  previous: AgentEventEnvelope,
  next: AgentEventEnvelope,
): AgentEventEnvelope {
  if (
    previous.event.type !== "message_update" ||
    next.event.type !== "message_update" ||
    previous.event.message.id !== next.event.message.id
  ) {
    return next;
  }
  return {
    ...next,
    event: mergeMessageUpdates(previous.event, next.event),
  };
}

/**
 * Patch a live `UiMessage` with a streaming update.
 *
 * Snapshot updates (`stream` omitted) replace the row. Delta updates append
 * unless `resetText` / `resetThinking` is set.
 */
export function applyMessageUpdate(
  previous: UiMessage | undefined,
  event: MessageUpdateEvent,
): UiMessage {
  if (event.stream !== "delta") return event.message;
  const seed =
    previous && previous.id === event.message.id ? previous : event.message;
  let content = seed.content ?? "";
  let thinking = seed.thinking ?? "";
  if (event.resetText) content = event.deltaText ?? "";
  else if (event.deltaText) content += event.deltaText;
  if (event.resetThinking) thinking = event.deltaThinking ?? "";
  else if (event.deltaThinking) thinking += event.deltaThinking;
  return {
    ...seed,
    id: event.message.id,
    role: event.message.role,
    createdAt: event.message.createdAt || seed.createdAt,
    status: event.message.status ?? seed.status,
    content,
    ...(thinking ? { thinking } : { thinking: undefined }),
    ...(event.message.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: event.message.timeToFirstTokenMs } : {}),
    ...(event.message.modelId ? { modelId: event.message.modelId } : {}),
    ...(event.message.providerId ? { providerId: event.message.providerId } : {}),
    ...(event.message.parentToolCallId
      ? { parentToolCallId: event.message.parentToolCallId }
      : {}),
    ...(event.message.agentName ? { agentName: event.message.agentName } : {}),
    ...(event.message.hostedSearch
      ? { hostedSearch: event.message.hostedSearch }
      : seed.hostedSearch
        ? { hostedSearch: seed.hostedSearch }
        : {}),
  };
}

/**
 * Cheap size gate for `item.delta` frames. Avoids `JSON.stringify` on the
 * streaming hot path when the payload is obviously under the frame cap.
 */
export function deltaStreamPayloadFits(
  payload: unknown,
  maxBytes: number,
): boolean {
  if (maxBytes <= 0) return false;
  const event = (payload as { event?: MessageUpdateEvent } | null)?.event;
  if (!event || event.type !== "message_update" || event.stream !== "delta") {
    return false;
  }
  const chars =
    (event.deltaText?.length ?? 0) +
    (event.deltaThinking?.length ?? 0) +
    (event.message?.id?.length ?? 0) +
    768;
  return chars * 3 < maxBytes;
}
