import type { ComposerDraftSnapshot } from "./composer-smart-stop";

export type QueuedPrompt = {
  id: string;
  sessionId: string;
  content: string;
  draft: ComposerDraftSnapshot;
  createdAt: number;
  /**
   * Set once the row was promoted with Send now. Promoted rows form the head
   * of the queue in ascending priority (click) order; they start next and stay
   * ordered until the Host delivers or cancels them.
   */
  priority?: number;
};

export type QueuedPromptDirection = "up" | "down";

export type QueuedPrompts = Record<string, QueuedPrompt[]>;

function withSessionQueue(
  queues: QueuedPrompts,
  sessionId: string,
  queue: QueuedPrompt[],
): QueuedPrompts {
  const next = { ...queues };
  if (queue.length === 0) delete next[sessionId];
  else next[sessionId] = queue;
  return next;
}

export function enqueueQueuedPrompt(
  queues: QueuedPrompts,
  item: QueuedPrompt,
): QueuedPrompts {
  const queue = queues[item.sessionId] ?? [];
  return withSessionQueue(queues, item.sessionId, [...queue, item]);
}

export function removeQueuedPrompt(
  queues: QueuedPrompts,
  sessionId: string,
  promptId: string,
): QueuedPrompts {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((item) => item.id !== promptId);
  return remaining.length === queue.length
    ? queues
    : withSessionQueue(queues, sessionId, remaining);
}

/** Optimistic rows the Host has not acknowledged yet. */
export function isPendingQueuedPrompt(item: QueuedPrompt): boolean {
  return item.id.startsWith("pending:");
}

/** A promoted row keeps its delivery order, but may still be canceled. */
export function isPromotedQueuedPrompt(
  item: QueuedPrompt,
): item is QueuedPrompt & { priority: number } {
  return item.priority !== undefined;
}

/**
 * Send now: promote one row behind the already promoted block. Click order is
 * priority order, and only the promoted block is ordered by priority.
 */
export function promoteQueuedPrompt(
  queues: QueuedPrompts,
  sessionId: string,
  promptId: string,
): QueuedPrompts {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const item = queue.find((candidate) => candidate.id === promptId);
  if (!item || isPromotedQueuedPrompt(item)) return queues;
  const remaining = queue.filter((candidate) => candidate.id !== promptId);
  const promoted = remaining.filter(isPromotedQueuedPrompt);
  const waiting = remaining.filter((candidate) => !isPromotedQueuedPrompt(candidate));
  const highest = promoted.reduce(
    (max, candidate) => Math.max(max, candidate.priority),
    -1,
  );
  return withSessionQueue(queues, sessionId, [
    ...promoted,
    { ...item, priority: highest + 1 },
    ...waiting,
  ]);
}

/**
 * Move one waiting row past its adjacent waiting neighbour. Promoted rows are
 * locked, so the promoted block boundary is a no-op.
 */
export function reorderQueuedPrompt(
  queues: QueuedPrompts,
  sessionId: string,
  promptId: string,
  direction: QueuedPromptDirection,
): QueuedPrompts {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const index = queue.findIndex((item) => item.id === promptId);
  const item = queue[index];
  if (!item || isPromotedQueuedPrompt(item)) return queues;
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  const target = queue[targetIndex];
  if (!target || isPromotedQueuedPrompt(target)) return queues;
  const next = [...queue];
  next[index] = target;
  next[targetIndex] = item;
  return withSessionQueue(queues, sessionId, next);
}

export function queuedPromptForSession(
  queues: QueuedPrompts,
  sessionId: string,
  promptId: string,
): QueuedPrompt | undefined {
  return queues[sessionId]?.find((item) => item.id === promptId);
}
