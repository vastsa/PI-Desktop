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
  const durable = dedupeSessionMessages(durableMessages);
  const liveNormalized = dedupeSessionMessages(liveMessages);
  if (liveNormalized.length === 0) return durable;

  const liveById = new Map(liveNormalized.map((message) => [message.id, message]));
  let changed = false;
  const merged = durable.map((durable) => {
    const live = liveById.get(durable.id);
    if (!live) return durable;
    liveById.delete(durable.id);
    if (isInFlightMessage(live)) {
      if (live !== durable) changed = true;
      return live;
    }
    return durable;
  });

  for (const live of liveNormalized) {
    if (!liveById.has(live.id)) continue;
    liveById.delete(live.id);
    merged.push(live);
    changed = true;
  }
  return changed ? merged : durable;
}

function isInFlightMessage(message: UiMessage): boolean {
  return message.status === "streaming" || message.toolStatus === "running";
}
