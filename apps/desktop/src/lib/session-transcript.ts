import type { MessageAttachment, UiMessage } from "@pi-desktop/shared";

type OptimisticFileReference = {
  path: string;
  name: string;
  kind?: "image" | "file";
  mimeType?: string;
  /** Large-text paste tokens travel inline in the text, not as attachments. */
  token?: string;
};

/**
 * The user row shown the moment a prompt is sent, before the host has
 * persisted or echoed it (D288). The host reuses `id`, so its echo replaces
 * this row in place; attachments show under their source path until the
 * durable row brings the session-scoped ref.
 */
export function optimisticUserMessage(
  id: string,
  content: string,
  fileReferences: readonly OptimisticFileReference[] = [],
  createdAt: string = new Date().toISOString(),
): UiMessage {
  const attachments: MessageAttachment[] = fileReferences
    .filter((reference) => !reference.token)
    .map((reference) => ({
      kind:
        reference.kind ??
        (/\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(reference.path)
          ? "image"
          : "file"),
      name: reference.name,
      ref: reference.path,
      ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    }));
  return {
    id,
    role: "user",
    content,
    createdAt,
    status: "complete",
    ...(attachments.length ? { attachments } : {}),
  };
}

/**
 * Collapse repeated transcript rows by their canonical message id.
 *
 * A retry or a stale page response can briefly put the same durable row in
 * both the live snapshot and the page being prepended. Keep the first
 * position, but use the last value, matching host-core's keep-last policy.
 */
export function dedupeSessionMessages(messages: UiMessage[]): UiMessage[] {
  const positions = new Map<string, number>();
  let next: UiMessage[] | undefined;
  for (const [index, message] of messages.entries()) {
    const previous = positions.get(message.id);
    if (previous === undefined) {
      if (next) {
        positions.set(message.id, next.length);
        next.push(message);
      } else {
        positions.set(message.id, index);
      }
      continue;
    }
    if (!next) next = messages.slice(0, index);
    next[previous] = message;
  }
  return next ?? messages;
}

/**
 * Apply one live event message to a renderer-owned session snapshot without
 * rebuilding the whole transcript when the row is unchanged.
 */
export function upsertLiveSessionMessage(
  messages: UiMessage[],
  message: UiMessage,
): UiMessage[] {
  const normalized = dedupeSessionMessages(messages);
  const index = normalized.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...normalized, message];
  if (normalized[index] === message) return normalized;
  const next = normalized.slice();
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
  const normalized = dedupeSessionMessages(messages);
  const index = normalized.findIndex((message) => message.id === messageId);
  if (index < 0) return normalized;
  return [...normalized.slice(0, index), ...normalized.slice(index + 1)];
}

/**
 * Treat a durable session read as a lower-water mark while live rows exist.
 *
 * Streaming assistant/tool rows are not persisted until their terminal event,
 * and a just-completed reply may still sit in the persistence outbox, so a
 * session opened during or right after a reply can receive a detail response
 * that is missing that tail. Keep those live rows. Completed rows from the
 * durable read remain authoritative when both sides contain the same id.
 *
 * The durable read is a bounded newest page (ADR 0120). A renderer that stayed
 * on the session already holds older live rows plus any optimistic/in-flight
 * tail. Those live-only rows must keep their chronological place: older ones
 * stay before the durable page, newer ones stay after it. Appending them after
 * the page would move the newest turn out of D261's trailing mounted window,
 * which is what made a just-sent prompt vanish on switch (D317).
 */
export function mergeLiveSessionMessages(
  durableMessages: UiMessage[],
  liveMessages: UiMessage[],
): UiMessage[] {
  const durable = dedupeSessionMessages(durableMessages);
  const liveNormalized = dedupeSessionMessages(liveMessages);
  if (liveNormalized.length === 0) return durable;
  if (durable.length === 0) return liveNormalized;

  const durableIds = new Set(durable.map((message) => message.id));
  const liveIndexById = new Map(
    liveNormalized.map((message, index) => [message.id, index]),
  );

  let firstSharedLive = -1;
  let lastSharedLive = -1;
  for (const [index, message] of liveNormalized.entries()) {
    if (!durableIds.has(message.id)) continue;
    if (firstSharedLive < 0) firstSharedLive = index;
    lastSharedLive = index;
  }

  const used = new Set<string>();
  const merged: UiMessage[] = [];
  const push = (message: UiMessage) => {
    if (used.has(message.id)) return;
    used.add(message.id);
    merged.push(message);
  };

  if (firstSharedLive > 0) {
    for (const message of liveNormalized.slice(0, firstSharedLive)) {
      if (!durableIds.has(message.id)) push(message);
    }
  }

  // A previous append-after-page merge left older live rows after the durable
  // window. Restore them in front when their timestamps precede the page.
  const windowStartAt = durable[0]?.createdAt;
  if (lastSharedLive >= 0 && windowStartAt) {
    for (const message of liveNormalized.slice(lastSharedLive + 1)) {
      if (durableIds.has(message.id)) continue;
      if (message.createdAt && message.createdAt < windowStartAt) {
        push(message);
      }
    }
  }

  for (const durableMessage of durable) {
    const liveIndex = liveIndexById.get(durableMessage.id);
    const live =
      liveIndex === undefined ? undefined : liveNormalized[liveIndex];
    push(live && isInFlightMessage(live) ? live : durableMessage);
    // Live-only rows between two durable ids belong in the overlap. Trailing
    // rows after the last shared id wait until the durable page is complete
    // so a not-yet-cached user echo stays ahead of the streaming tail.
    if (liveIndex === undefined || liveIndex >= lastSharedLive) continue;
    for (
      let index = liveIndex + 1;
      index < liveNormalized.length && !durableIds.has(liveNormalized[index].id);
      index++
    ) {
      push(liveNormalized[index]);
    }
  }

  for (const message of liveNormalized) {
    if (!used.has(message.id)) push(message);
  }

  const unchanged =
    merged.length === durable.length &&
    merged.every((message, index) => message === durable[index]);
  return unchanged ? durable : merged;
}

function isInFlightMessage(message: UiMessage): boolean {
  return message.status === "streaming" || message.toolStatus === "running";
}

/**
 * Whether a durable session page already contains every live row.
 *
 * Live provenance can drop only after this is true. Assistant/tool rows are
 * not persisted until the outbox drains, so an idle switch that replaced the
 * snapshot with the durable page would drop replies that were already on
 * screen (D324).
 */
export function durableCoversLiveSessionMessages(
  durableMessages: UiMessage[],
  liveMessages: UiMessage[] | undefined,
): boolean {
  if (!liveMessages || liveMessages.length === 0) return true;
  const durableIds = new Set(durableMessages.map((message) => message.id));
  return liveMessages.every((message) => durableIds.has(message.id));
}
