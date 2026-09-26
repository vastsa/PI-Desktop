/**
 * Process-memory registry of pending Agent asktool questions.
 *
 * The desktop renderer receives every `asktool_request` as an in-memory
 * `AgentEventEnvelope`; the local MCP control plane can answer such a
 * question (`agent/askTool/resolve`) but could not read it back: the request
 * id lives only in the renderer's zustand store. This registry ingests the
 * same envelopes in Electron main so a phone client can discover the
 * requestId and the questions it needs for the resolve operation.
 *
 * Security bounds:
 * - Process memory only. Never persisted to disk, log, notification, or
 *   transcript. State dies with the process, matching the runtime's own
 *   pending-request lifetime.
 * - Bounded per session: when a session accumulates more than
 *   {@link MAX_PENDING_ASKS_PER_SESSION} unresolved requests, the oldest
 *   entry is pruned first. No unbounded growth.
 * - `list()` returns structural clones so callers cannot mutate the
 *   registry's references.
 *
 * Lifecycle:
 * - `asktool_request` adds (or dedupes by requestId).
 * - `tool_end` for the same session removes the entry whose `toolCallId`
 *   matches (the asktool call has completed).
 * - `agent_end` clears the session: the turn is over and every unresolved
 *   request is dead for that session.
 */

import type {
  AgentEventEnvelope,
  AskToolQuestion,
  AskToolRequest,
} from "@pi-desktop/shared";

/** Hard per-session bound; pruned oldest-first. */
export const MAX_PENDING_ASKS_PER_SESSION = 20;

/** Hard global bound on session buckets; prevents stale remote hosts from growing memory forever. */
export const MAX_PENDING_ASK_SESSIONS = 1024;

/** One pending ask as exposed over the read operation. */
export type PendingAsk = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  questions: AskToolQuestion[];
  receivedAt: number;
};

export type PendingAsksResult = {
  kind: "pending" | "none";
  asks: PendingAsk[];
};

export type PendingAsksRegistry = {
  ingest: (envelope: AgentEventEnvelope) => void;
  settle: (sessionId: string, requestId: string) => void;
  clearSession: (sessionId: string) => void;
  /**
   * Drop every bucket whose session id starts with `prefix`. Used when a remote
   * host goes away: its asks can never be answered afterwards, and the ids are
   * namespaced (`remote:<hostKey>:<hostSessionId>`), so the prefix is exact.
   * Returns the number of buckets removed.
   */
  clearSessionsWithPrefix: (prefix: string) => number;
  list: (sessionId?: string) => PendingAsksResult;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Create the main-process pending-asks registry. Pure in-memory state with
 * no timers, no persistence, and no external dependencies beyond the
 * shared `AgentEventEnvelope` contract.
 */
export function createPendingAsksRegistry(): PendingAsksRegistry {
  /** sessionId -> Array<PendingAsk>, ordered by receipt. */
  const bySession = new Map<string, PendingAsk[]>();

  /**
   * Keep the bucket count bounded. A remote host that disconnects without
   * resolving its asks (or a long-lived desktop accumulating dead sessions)
   * must not grow process memory without limit; the per-session cap alone does
   * not bound the number of sessions. The oldest bucket (Map insertion order)
   * goes first, matching the per-session oldest-first policy.
   */
  const evictOldestSessions = (): void => {
    while (bySession.size > MAX_PENDING_ASK_SESSIONS) {
      const oldest = bySession.keys().next();
      if (oldest.done) return;
      bySession.delete(oldest.value);
    }
  };

  const ingest = (envelope: AgentEventEnvelope): void => {
    if (!envelope || typeof envelope !== "object") return;
    const sessionId = String(envelope.sessionId ?? "").trim();
    const event = envelope.event;
    if (!sessionId || !event) return;
    if (event.type === "asktool_request") {
      const request: AskToolRequest | undefined = event.request;
      if (
        !request ||
        !isNonEmptyString(request.requestId) ||
        !isNonEmptyString(request.toolCallId) ||
        request.sessionId !== sessionId ||
        !Array.isArray(request.questions)
      ) {
        return;
      }
      const questions: AskToolQuestion[] = [];
      for (const raw of request.questions as unknown[]) {
        if (!raw || typeof raw !== "object") return;
        const question = raw as Partial<AskToolQuestion>;
        if (
          !isNonEmptyString(question.question) ||
          !Array.isArray(question.options) ||
          !question.options.every((option) => typeof option === "string")
        ) {
          return;
        }
        questions.push({
          question: question.question,
          options: [...question.options],
          ...(question.multiSelect === true ? { multiSelect: true } : {}),
        });
      }
      if (questions.length === 0) return;
      const existing = bySession.get(sessionId) ?? [];
      if (existing.some((ask) => ask.requestId === request.requestId)) return;
      const entry: PendingAsk = {
        requestId: request.requestId,
        sessionId,
        toolCallId: request.toolCallId,
        questions,
        receivedAt: Number.isFinite(envelope.ts) ? envelope.ts : Date.now(),
      };
      const next = [...existing, entry];
      while (next.length > MAX_PENDING_ASKS_PER_SESSION) {
        next.shift();
      }
      // Re-insert so this session becomes the newest bucket: Map iteration order
      // is insertion order, which is what `evictOldestSessions` relies on.
      bySession.delete(sessionId);
      bySession.set(sessionId, next);
      evictOldestSessions();
      return;
    }
    if (event.type === "tool_end") {
      const toolCallId = event.toolCallId;
      if (!isNonEmptyString(toolCallId)) return;
      const existing = bySession.get(sessionId);
      if (!existing?.length) return;
      const remaining = existing.filter((ask) => ask.toolCallId !== toolCallId);
      if (remaining.length === existing.length) return;
      if (remaining.length === 0) bySession.delete(sessionId);
      else bySession.set(sessionId, remaining);
      return;
    }
    if (event.type === "agent_end") {
      bySession.delete(sessionId);
    }
  };

  const settle = (sessionId: string, requestId: string): void => {
    const normalizedSessionId = String(sessionId ?? "").trim();
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedSessionId || !normalizedRequestId) return;
    const existing = bySession.get(normalizedSessionId);
    if (!existing?.length) return;
    const remaining = existing.filter(
      (ask) => ask.requestId !== normalizedRequestId,
    );
    if (remaining.length === existing.length) return;
    if (remaining.length === 0) bySession.delete(normalizedSessionId);
    else bySession.set(normalizedSessionId, remaining);
  };

  const clearSession = (sessionId: string): void => {
    const normalized = String(sessionId ?? "").trim();
    if (normalized) bySession.delete(normalized);
  };

  const clearSessionsWithPrefix = (prefix: string): number => {
    const normalized = String(prefix ?? "");
    if (!normalized) return 0;
    let removed = 0;
    for (const sessionId of [...bySession.keys()]) {
      if (!sessionId.startsWith(normalized)) continue;
      bySession.delete(sessionId);
      removed += 1;
    }
    return removed;
  };

  const list = (sessionId?: string): PendingAsksResult => {
    const sources: PendingAsk[][] = [];
    if (isNonEmptyString(sessionId)) {
      const existing = bySession.get(sessionId.trim());
      if (existing?.length) sources.push(existing);
    } else {
      for (const bucket of bySession.values()) {
        if (bucket.length) sources.push(bucket);
      }
    }
    const asks = sources.flat().sort((left, right) => {
      if (left.receivedAt !== right.receivedAt) return left.receivedAt - right.receivedAt;
      return left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0;
    });
    return {
      kind: asks.length > 0 ? "pending" : "none",
      asks: asks.map((ask) => ({
        ...ask,
        questions: ask.questions.map((question) => ({
          ...question,
          options: [...question.options],
        })),
      })),
    };
  };

  return { ingest, settle, clearSession, clearSessionsWithPrefix, list };
}

/** Shared process-memory registry used by local, native and remote event paths. */
export const pendingAsksRegistry = createPendingAsksRegistry();
