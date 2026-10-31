import type { AskToolQuestion, AskToolRequest } from "@pi-desktop/shared";

export type PendingAsk = AskToolRequest;
export type AskQueues = Record<string, PendingAsk[]>;

function withQueue(queues: AskQueues, sessionId: string, queue: PendingAsk[]): AskQueues {
  const next = { ...queues };
  if (queue.length === 0) delete next[sessionId];
  else next[sessionId] = queue;
  return next;
}

export function enqueueAsk(queues: AskQueues, request: PendingAsk): AskQueues {
  const queue = queues[request.sessionId] ?? [];
  if (queue.some((entry) => entry.requestId === request.requestId)) return queues;
  return withQueue(queues, request.sessionId, [...queue, request]);
}

export function headAsk(queues: AskQueues, sessionId?: string): PendingAsk | undefined {
  return sessionId ? queues[sessionId]?.[0] : undefined;
}

export function queuedAskCount(queues: AskQueues, sessionId?: string): number {
  return Math.max(0, (sessionId ? (queues[sessionId]?.length ?? 0) : 0) - 1);
}

export function removeAsk(
  queues: AskQueues,
  sessionId: string,
  requestId: string,
): AskQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((entry) => entry.requestId !== requestId);
  return remaining.length === queue.length
    ? queues
    : withQueue(queues, sessionId, remaining);
}

export function removeAskForToolCall(
  queues: AskQueues,
  sessionId: string,
  toolCallId: string,
): AskQueues {
  const queue = queues[sessionId];
  if (!queue) return queues;
  const remaining = queue.filter((entry) => entry.toolCallId !== toolCallId);
  return remaining.length === queue.length
    ? queues
    : withQueue(queues, sessionId, remaining);
}

export function clearSessionAsks(queues: AskQueues, sessionId: string): AskQueues {
  if (!queues[sessionId]) return queues;
  const next = { ...queues };
  delete next[sessionId];
  return next;
}

/** One question's in-progress answer, owned by the store so a remount is harmless. */
export type AskDraftAnswer = {
  values: string[];
  customSelected: boolean;
  customText: string;
  skipped: boolean;
};

/** The card's per-request draft: which question is open plus every answer. */
export type AskDraft = {
  index: number;
  answers: AskDraftAnswer[];
};

/** Drafts keyed by requestId; the ask itself already lives in `AskQueues`. */
export type AskDrafts = Record<string, AskDraft>;

export function emptyAskDraft(questions: AskToolQuestion[]): AskDraft {
  return {
    index: 0,
    answers: questions.map(() => ({
      values: [],
      customSelected: false,
      customText: "",
      skipped: false,
    })),
  };
}

export function setAskDraft(
  drafts: AskDrafts,
  requestId: string,
  draft: AskDraft,
): AskDrafts {
  return { ...drafts, [requestId]: draft };
}

export function dropAskDraft(drafts: AskDrafts, requestId: string): AskDrafts {
  if (!(requestId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[requestId];
  return next;
}

/** Drop the drafts of every ask still queued for a session. */
export function dropSessionAskDrafts(
  drafts: AskDrafts,
  queues: AskQueues,
  sessionId: string,
): AskDrafts {
  const queue = queues[sessionId];
  if (!queue || queue.length === 0) return drafts;
  let next = drafts;
  for (const ask of queue) next = dropAskDraft(next, ask.requestId);
  return next;
}

/** Drop the drafts of the asks tied to one tool call. */
export function dropToolCallAskDrafts(
  drafts: AskDrafts,
  queues: AskQueues,
  sessionId: string,
  toolCallId: string,
): AskDrafts {
  const queue = queues[sessionId];
  if (!queue || queue.length === 0) return drafts;
  let next = drafts;
  for (const ask of queue) {
    if (ask.toolCallId === toolCallId) next = dropAskDraft(next, ask.requestId);
  }
  return next;
}
