import { preservePlanHistory } from "./plan-history";
import type { AgentEvent, MessageAttachment, UiMessage } from "@pi-desktop/shared";
import { formatPromptPathText, locateInlinePromptPaths } from "@pi-desktop/shared";
import {
  getSessionMessageSnapshot,
  registerSessionMessageAppend,
  registerSessionMessageReplacement,
  registerSessionMessageRewrite,
} from "./session-transcript-updates";

type OptimisticFileReference = {
  path: string;
  name: string;
  kind?: "image" | "file" | "session";
  mimeType?: string;
  /** Large-text paste tokens travel inline in the text, not as attachments. */
  token?: string;
};

const OPTIMISTIC_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OPTIMISTIC_ECHO_DELAY_MS = 30_000;
const IMAGE_PATH_PATTERN = /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i;

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
  // A plain file chip travels as `@path` text and needs no attachment row, but
  // an image chip is one: it also records where its path sits, so the row shows
  // the image in place before the durable echo arrives (D288).
  const rendered = fileReferences.flatMap((reference) => {
    const kind =
      reference.kind ??
      (IMAGE_PATH_PATTERN.test(reference.path) ? ("image" as const) : ("file" as const));
    return reference.token && kind !== "image" ? [] : [{ reference, kind }];
  });
  const spans = locateInlinePromptPaths(
    content,
    rendered.map(({ reference }) => reference.path),
  );
  const attachments: MessageAttachment[] = rendered.map(({ reference, kind }, index) => ({
    kind,
    name: reference.name,
    ref: reference.path,
    ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    ...(spans[index] ? { inlinePath: formatPromptPathText(reference.path) } : {}),
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
 * Terminal projection for one `message_end` event.
 *
 * Native Pi sessions mint SDK entry ids when the message is appended, so the
 * live row streams under a provisional id and the terminal event names that id
 * in `replacesMessageId`. Only that exact row is re-keyed; a generic Desktop
 * terminal event carries no metadata and must leave every other row alone
 * (parallel delegate streams, replayed historical completions).
 */
export function projectMessageEnd(
  messages: UiMessage[],
  event: Extract<AgentEvent, { type: "message_end" }>,
): UiMessage[] {
  let next = messages;
  const replacesMessageId = event.replacesMessageId;
  if (replacesMessageId && replacesMessageId !== event.message.id) {
    const index = messages.findIndex(
      (message) =>
        message.id === replacesMessageId && message.role === "assistant",
    );
    if (index >= 0) {
      next = registerSessionMessageRewrite(messages, [
        ...messages.slice(0, index), ...messages.slice(index + 1),
      ]);
    }
  }
  const failed =
    event.message.status === "error" || event.message.status === "aborted";
  const empty =
    !(event.message.content || "").trim() &&
    !(event.message.thinking || "").trim();
  return failed && empty && !event.message.error
    ? removeLiveSessionMessage(next, event.message.id)
    : upsertLiveSessionMessage(next, event.message);
}

/**
 * Collapse repeated transcript rows by their canonical message id.
 *
 * A retry or a stale page response can briefly put the same durable row in
 * both the live snapshot and the page being prepended. Keep the first
 * position, but use the last value, matching host-core's keep-last policy.
 */
export function dedupeSessionMessages(messages: UiMessage[]): UiMessage[] {
  if (getSessionMessageSnapshot(messages).unique) return messages;
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
  return next ? registerSessionMessageRewrite(messages, next) : messages;
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
  const index = getSessionMessageSnapshot(normalized).positions.get(message.id);
  if (index === undefined) return registerSessionMessageAppend(normalized, [...normalized, message]);
  if (normalized[index] === message) return normalized;
  const next = normalized.slice();
  next[index] = preservePlanHistory(message, normalized[index]);
  return registerSessionMessageReplacement(normalized, next, index);
}

/** Replace only the acknowledged submission identity, never an equal-text row. */
export function reconcilePersistedUserMessage(
  messages: UiMessage[],
  optimisticMessageId: string,
  message: UiMessage,
): UiMessage[] {
  if (
    message.role !== "user" ||
    !messages.some((row) => row.id === optimisticMessageId && row.role === "user")
  ) return messages;
  return upsertLiveSessionMessage(
    registerSessionMessageRewrite(messages,
      messages.map((row) => row.id === optimisticMessageId ? message : row)),
    message,
  );
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
  const index = getSessionMessageSnapshot(normalized).positions.get(messageId);
  if (index === undefined) return normalized;
  return registerSessionMessageRewrite(normalized, [
    ...normalized.slice(0, index), ...normalized.slice(index + 1),
  ]);
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
  // An optimistic prompt whose reconcile event was missed survives with its
  // temporary UUID id, so id-based merging can replay it next to the durable
  // echo (#1308). Content alone is not identity: only collapse an attachment-
  // free optimistic row when one same-text durable user row was persisted
  // shortly after that optimistic row. This keeps an older identical prompt
  // from hiding a newly submitted one.
  const matchedDurableUserIds = new Set<string>();
  const collapsedOptimisticIds = new Set<string>();
  for (const optimistic of liveNormalized) {
    if (
      optimistic.role !== "user" ||
      optimistic.status !== "complete" ||
      !OPTIMISTIC_USER_ID.test(optimistic.id) ||
      durableIds.has(optimistic.id) ||
      optimistic.attachments?.length
    ) continue;
    const optimisticTime = Date.parse(optimistic.createdAt ?? "");
    if (!Number.isFinite(optimisticTime)) continue;
    const candidates = durable
      .filter((message) =>
        message.role === "user" &&
        !message.attachments?.length &&
        !matchedDurableUserIds.has(message.id) &&
        message.content === optimistic.content,
      )
      .map((message) => ({
        message,
        delay: Date.parse(message.createdAt ?? "") - optimisticTime,
      }))
      .filter(({ delay }) => delay >= 0 && delay <= MAX_OPTIMISTIC_ECHO_DELAY_MS)
      .sort((left, right) => left.delay - right.delay);
    if (!candidates.length) continue;
    if (candidates.length > 1 && candidates[0].delay === candidates[1].delay) continue;
    matchedDurableUserIds.add(candidates[0].message.id);
    collapsedOptimisticIds.add(optimistic.id);
  }
  const merged: UiMessage[] = [];
  const push = (message: UiMessage) => {
    if (used.has(message.id)) return;
    if (collapsedOptimisticIds.has(message.id)) {
      used.add(message.id);
      return;
    }
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
    push(preservePlanHistory(live && isInFlightMessage(live) ? live : durableMessage, live));
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
    if (used.has(message.id)) continue;
    push(message);
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
