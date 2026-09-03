import type { UiMessage } from "@pi-desktop/shared";

/**
 * Apply one live event message to a renderer-owned session snapshot without
 * rebuilding the whole transcript when the row is unchanged.
 */
export function upsertLiveSessionMessage(
  messages: UiMessage[],
  message: UiMessage,
): UiMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  if (messages[index] === message) return messages;
  const next = messages.slice();
  next[index] = message;
  return next;
}

/**
 * Remove an in-memory row that was never durably useful (for example an empty
 * abort).
 */
export function removeLiveSessionMessage(
  messages: UiMessage[],
  messageId: string,
): UiMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  return [...messages.slice(0, index), ...messages.slice(index + 1)];
}

/**
 * Treat a durable session read as a lower-water mark while a turn is live.
 *
 * Streaming assistant/tool rows are not persisted until their terminal event,
 * so a session opened during a reply can receive a detail response that is
 * missing the in-flight tail. Keep those live rows and append any durable rows
 * that arrived since the in-memory snapshot was captured. Completed rows from
 * the durable read remain authoritative when both sides contain the same id.
 */
export function mergeLiveSessionMessages(
  durableMessages: UiMessage[],
  liveMessages: UiMessage[],
): UiMessage[] {
  if (liveMessages.length === 0) return durableMessages;

  const liveById = new Map(liveMessages.map((message) => [message.id, message]));
  let changed = false;
  const merged = durableMessages.map((durable) => {
    const live = liveById.get(durable.id);
    if (!live) return durable;
    liveById.delete(durable.id);
    if (isInFlightMessage(live)) {
      if (live !== durable) changed = true;
      return live;
    }
    return durable;
  });

  for (const live of liveMessages) {
    if (!liveById.has(live.id)) continue;
    liveById.delete(live.id);
    merged.push(live);
    changed = true;
  }
  return changed ? merged : durableMessages;
}

function isInFlightMessage(message: UiMessage): boolean {
  return message.status === "streaming" || message.toolStatus === "running";
}
