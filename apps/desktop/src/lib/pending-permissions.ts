import type { ToolPermissionRequest } from "@pi-desktop/shared";

export type PendingPermission = ToolPermissionRequest;

/**
 * Per-session queue of permission requests, oldest first.
 *
 * One session used to have at most one open request, because one agent asked one
 * question at a time. Parallel subagents (ADR 0062) broke that: two delegates
 * can each hit a gated tool in the same instant. The renderer answers them one
 * at a time in arrival order — the alternative is a stack of dialogs for work
 * the user cannot tell apart.
 *
 * A session with nothing pending has no key at all, never an empty array, so
 * "does this session need attention" stays a presence check.
 */
export type PermissionQueues = Record<string, PendingPermission[]>;

function withQueue(
  queues: PermissionQueues,
  sessionId: string,
  queue: PendingPermission[],
): PermissionQueues {
  const next = { ...queues };
  if (queue.length === 0) delete next[sessionId];
  else next[sessionId] = queue;
  return next;
}

/** Append a request, ignoring a duplicate delivery of one already queued. */
export function enqueuePermission(
  queues: PermissionQueues,
  permission: PendingPermission,
): PermissionQueues {
  const queue = queues[permission.sessionId] ?? [];
  if (queue.some((entry) => entry.requestId === permission.requestId)) return queues;
  return withQueue(queues, permission.sessionId, [...queue, permission]);
}

/** The request the session is currently asking about. */
export function headPermission(
  queues: PermissionQueues,
  sessionId: string | undefined,
): PendingPermission | undefined {
  return sessionId ? queues[sessionId]?.[0] : undefined;
}

/** How many requests wait behind the one on screen. */
export function queuedPermissionCount(
  queues: PermissionQueues,
  sessionId: string | undefined,
): number {
  return Math.max(0, (sessionId ? (queues[sessionId]?.length ?? 0) : 0) - 1);
}

export function sessionPermissions(
  queues: PermissionQueues,
  sessionId: string,
): PendingPermission[] {
  return queues[sessionId] ?? [];
}

/**
 * Drop one request. Matching by id rather than position is what makes a late
 * answer safe: it can only ever clear the request it answered.
 */
export function removePermission(
  queues: PermissionQueues,
  sessionId: string,
  requestId: string,
): PermissionQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((entry) => entry.requestId !== requestId);
  if (remaining.length === queue.length) return queues;
  return withQueue(queues, sessionId, remaining);
}

/**
 * Drop the request a finished tool call was waiting on, wherever it sits in the
 * queue. The host answers an expired or cancelled request itself, and this is
 * how a queued card that was never shown leaves the queue.
 */
export function removePermissionForToolCall(
  queues: PermissionQueues,
  sessionId: string,
  toolCallId: string,
): PermissionQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((entry) => entry.toolCallId !== toolCallId);
  if (remaining.length === queue.length) return queues;
  return withQueue(queues, sessionId, remaining);
}

/** Forget everything a session had pending (turn ended, session deleted). */
export function clearSessionPermissions(
  queues: PermissionQueues,
  sessionId: string,
): PermissionQueues {
  if (!queues[sessionId]) return queues;
  const next = { ...queues };
  delete next[sessionId];
  return next;
}
