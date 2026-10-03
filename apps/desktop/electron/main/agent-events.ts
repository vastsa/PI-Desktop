/**
 * Process-memory fan-out hub for Agent events toward external control clients.
 *
 * The desktop renderer receives every `AgentEventEnvelope` through
 * `IPC.event.agentMessage`; the MCP control plane, however, has been POST-only,
 * so a remote client polling `pi_agent_status` / `pi_session_get` every couple
 * of seconds was the only way to observe progress — one desktop RPC per session
 * per tick, and every event between two polls is lost. This hub ingests the
 * same envelopes the renderer sees, in Electron main, and lets the control
 * server push them to a subscribed HTTP client instead of being polled.
 *
 * It mirrors `pending-asks.ts`: fed by the local sidecar, the native agent
 * event path and the remote event bridge; process memory only, never persisted
 * or logged; bounded subscriber count; deliveries are shallow clones so a
 * consumer cannot mutate what the next consumer sees.
 *
 * Backpressure lives with the transport, not here: an SSE response that falls
 * behind decides which envelopes to skip (the control server drops streaming
 * deltas first) and closes the connection when it cannot keep up. The hub only
 * guarantees unbounded subscriber growth cannot happen.
 */

import type { AgentEventEnvelope } from "@pi-desktop/shared";

/** Hard bound on concurrent subscribers; the SSE endpoint rejects beyond this. */
export const MAX_AGENT_EVENT_SUBSCRIBERS = 16;

export type AgentEventListener = (envelope: AgentEventEnvelope) => void;

export type AgentEventSubscription = {
  readonly clientId: string;
  /** Remove the listener. Safe to call more than once. */
  unsubscribe: () => void;
};

export type AgentEventSubscribeOptions = {
  /** Only deliver envelopes for these session ids; omit for every session. */
  sessionIds?: readonly string[];
};

export type AgentEventHub = {
  /**
   * Feed one envelope to every matching subscriber. A listener that throws is
   * isolated: it is removed (a broken SSE response must not break the emitter)
   * and the remaining listeners still receive the event.
   */
  ingest: (envelope: AgentEventEnvelope) => void;
  subscribe: (
    listener: AgentEventListener,
    options?: AgentEventSubscribeOptions,
  ) => AgentEventSubscription | null;
  unsubscribe: (clientId: string) => void;
  subscriberCount: () => number;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

type ListenerRecord = {
  clientId: string;
  listener: AgentEventListener;
  sessionIds: ReadonlySet<string> | null;
};

let clientIdCounter = 0;

export function createAgentEventHub(): AgentEventHub {
  const listeners = new Map<string, ListenerRecord>();

  const ingest = (envelope: AgentEventEnvelope): void => {
    if (!envelope || typeof envelope !== "object") return;
    const sessionId = envelope.sessionId;
    if (!isNonEmptyString(sessionId)) return;
    if (!envelope.event || typeof envelope.event !== "object") return;
    // Shallow clone: the emitter may mutate its envelope after we return (the
    // runtime reuses message objects across stream frames), and each listener
    // must observe its own copy of the top level.
    const snapshot: AgentEventEnvelope = { ...envelope };
    for (const record of [...listeners.values()]) {
      if (record.sessionIds && !record.sessionIds.has(sessionId)) continue;
      try {
        record.listener(snapshot);
      } catch {
        // A dead subscriber must not break the emitter or the others.
        listeners.delete(record.clientId);
      }
    }
  };

  const subscribe = (
    listener: AgentEventListener,
    options?: AgentEventSubscribeOptions,
  ): AgentEventSubscription | null => {
    if (typeof listener !== "function") return null;
    if (listeners.size >= MAX_AGENT_EVENT_SUBSCRIBERS) return null;
    const sessionIds = options?.sessionIds;
    const normalized =
      sessionIds && sessionIds.length > 0
        ? new Set(sessionIds.filter(isNonEmptyString))
        : null;
    if (normalized !== null && normalized.size === 0) return null;
    const clientId = `agent-events-${++clientIdCounter}`;
    listeners.set(clientId, { clientId, listener, sessionIds: normalized });
    return {
      clientId,
      unsubscribe: () => {
        listeners.delete(clientId);
      },
    };
  };

  const unsubscribe = (clientId: string): void => {
    const normalized = String(clientId ?? "").trim();
    if (normalized) listeners.delete(normalized);
  };


  const subscriberCount = (): number => listeners.size;

  return { ingest, subscribe, unsubscribe, subscriberCount };
}

/** Shared process-memory hub used by local, native and remote event paths. */
export const agentEventHub = createAgentEventHub();
