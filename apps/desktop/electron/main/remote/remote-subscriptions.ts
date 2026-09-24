/**
 * Bounded RACP event subscriptions for one remote host connection.
 *
 * The host caps subscriptions per connection (`maxSubscriptionsPerConnection`,
 * default 8). The host scope holds one slot for the connection's lifetime; the
 * rest go to session scopes, least recently used first out. A session that is
 * busy (running, awaiting a decision) is never evicted, so a turn in flight
 * keeps streaming even when the user browses other sessions.
 *
 * Acks are throttled: the host only needs the sequence to trim its replay
 * window, so one ack per burst is enough and a stream does not double its own
 * traffic. A subscription the host closes is reopened from its last safe
 * cursor while the session still holds a slot.
 */
import type { RacpCursor, RacpEventEnvelope, RacpSessionStatus } from "@pi-desktop/shared";

export type RemoteSubscriptionClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
};

export type RemoteSubscriptionsOptions = {
  client: RemoteSubscriptionClient;
  /** The host's per-connection subscription cap; defaults to 8. */
  maxSubscriptions?: number;
  /** Ack after this many durable events; defaults to 64. */
  ackEvery?: number;
  /** Ack a quieter stream after this delay; defaults to 250 ms. */
  ackDelayMs?: number;
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};

export interface RemoteSubscriptions {
  /** Subscribe to the host scope; held for the connection's lifetime. */
  openHost(): Promise<void>;
  /**
   * Make sure `hostSessionId` streams, evicting the least recently used idle
   * session when the cap is reached. `after` resumes from an attach cursor.
   */
  touch(hostSessionId: string, after?: RacpCursor): Promise<void>;
  /** Record a session's status; busy sessions are never evicted. */
  noteStatus(hostSessionId: string, status: RacpSessionStatus | undefined): void;
  /** Drop a session's subscription (the session is gone). */
  release(hostSessionId: string): Promise<void>;
  /** Feed every delivered envelope; drives the throttled acks. */
  observe(envelope: RacpEventEnvelope): void;
  /** The host closed a subscription; reopen it from `lastSafeCursor`. */
  closed(subscriptionId: string, lastSafeCursor: RacpCursor): void;
  /** Whether `hostSessionId` currently holds a subscription. */
  isSubscribed(hostSessionId: string): boolean;
  /** Forget every subscription (the transport went away). */
  reset(): void;
}

const DEFAULT_MAX = 8;
const DEFAULT_ACK_EVERY = 64;
const DEFAULT_ACK_DELAY_MS = 250;
/** Statuses whose session holds its slot until it settles. */
const BUSY: ReadonlySet<string> = new Set(["running", "waiting_permission"]);

type Slot = {
  subscriptionId: string | null;
  /** Monotonic use stamp; larger is more recent. */
  usedAt: number;
  pending?: Promise<void>;
};

type AckState = { sequence: number; unacked: number; timer: ReturnType<typeof setTimeout> | null };

export function createRemoteSubscriptions(options: RemoteSubscriptionsOptions): RemoteSubscriptions {
  const { client } = options;
  const log = options.log ?? (() => undefined);
  const capacity = Math.max(1, (options.maxSubscriptions ?? DEFAULT_MAX) - 1);
  const ackEvery = Math.max(1, options.ackEvery ?? DEFAULT_ACK_EVERY);
  const ackDelayMs = options.ackDelayMs ?? DEFAULT_ACK_DELAY_MS;

  let hostSubscriptionId: string | null = null;
  const slots = new Map<string, Slot>();
  const statuses = new Map<string, string>();
  const acks = new Map<string, AckState>();
  let clock = 0;
  let generation = 0;

  const subscriptionOwner = (subscriptionId: string): string | null => {
    for (const [sessionId, slot] of slots) {
      if (slot.subscriptionId === subscriptionId) return sessionId;
    }
    return null;
  };

  const flushAck = (subscriptionId: string) => {
    const state = acks.get(subscriptionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.unacked = 0;
    client
      .request("events/ack", { subscriptionId, sequence: state.sequence })
      .catch((error) => log("warn", "events/ack failed", error));
  };

  const dropAck = (subscriptionId: string | null) => {
    if (!subscriptionId) return;
    const state = acks.get(subscriptionId);
    if (state?.timer) clearTimeout(state.timer);
    acks.delete(subscriptionId);
  };

  const subscribe = async (params: Record<string, unknown>): Promise<string> => {
    const result = await client.request<{ subscriptionId: string }>("events/subscribe", params);
    return result.subscriptionId;
  };

  const unsubscribe = (subscriptionId: string | null) => {
    if (!subscriptionId) return;
    dropAck(subscriptionId);
    client
      .request("events/unsubscribe", { subscriptionId })
      .catch((error) => log("warn", "events/unsubscribe failed", error));
  };

  /** The least recently used idle session, or null when every slot is busy. */
  const evictionCandidate = (keep: string): string | null => {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [sessionId, slot] of slots) {
      if (sessionId === keep || slot.pending) continue;
      const status = statuses.get(sessionId);
      if (status !== undefined && BUSY.has(status)) continue;
      if (slot.usedAt < oldest) {
        oldest = slot.usedAt;
        victim = sessionId;
      }
    }
    return victim;
  };

  const open = (hostSessionId: string, slot: Slot, after?: RacpCursor): Promise<void> => {
    const startedIn = generation;
    const pending = subscribe({
      scope: "session",
      sessionId: hostSessionId,
      ...(after ? { after } : {}),
    })
      .then((subscriptionId) => {
        if (startedIn !== generation || slots.get(hostSessionId) !== slot) {
          // Released or reset while subscribing: give the slot straight back.
          unsubscribe(subscriptionId);
          return;
        }
        slot.subscriptionId = subscriptionId;
      })
      .catch((error) => {
        if (slots.get(hostSessionId) === slot) slots.delete(hostSessionId);
        log("warn", `events/subscribe failed for session ${hostSessionId}`, error);
      })
      .finally(() => {
        if (slot.pending === pending) delete slot.pending;
      });
    slot.pending = pending;
    return pending;
  };

  return {
    async openHost() {
      const startedIn = generation;
      try {
        const subscriptionId = await subscribe({ scope: "host" });
        if (startedIn === generation) hostSubscriptionId = subscriptionId;
      } catch (error) {
        log("warn", "events/subscribe host scope failed", error);
      }
    },
    async touch(hostSessionId, after) {
      const existing = slots.get(hostSessionId);
      if (existing) {
        existing.usedAt = ++clock;
        if (existing.pending) await existing.pending;
        return;
      }
      if (slots.size >= capacity) {
        const victim = evictionCandidate(hostSessionId);
        if (!victim) {
          log("warn", `no idle subscription slot for session ${hostSessionId}`);
          return;
        }
        const evicted = slots.get(victim);
        slots.delete(victim);
        unsubscribe(evicted?.subscriptionId ?? null);
      }
      const slot: Slot = { subscriptionId: null, usedAt: ++clock };
      slots.set(hostSessionId, slot);
      await open(hostSessionId, slot, after);
    },
    noteStatus(hostSessionId, status) {
      if (status === undefined) statuses.delete(hostSessionId);
      else statuses.set(hostSessionId, status);
    },
    async release(hostSessionId) {
      statuses.delete(hostSessionId);
      const slot = slots.get(hostSessionId);
      if (!slot) return;
      slots.delete(hostSessionId);
      unsubscribe(slot.subscriptionId);
    },
    observe(envelope) {
      if (envelope.sequence === undefined) return;
      const subscriptionId =
        envelope.scope === "host"
          ? hostSubscriptionId
          : envelope.sessionId !== undefined
            ? (slots.get(envelope.sessionId)?.subscriptionId ?? null)
            : null;
      if (!subscriptionId) return;
      let state = acks.get(subscriptionId);
      if (!state) {
        state = { sequence: 0, unacked: 0, timer: null };
        acks.set(subscriptionId, state);
      }
      state.sequence = Math.max(state.sequence, envelope.sequence);
      state.unacked += 1;
      if (state.unacked >= ackEvery) {
        flushAck(subscriptionId);
        return;
      }
      if (!state.timer) {
        state.timer = setTimeout(() => flushAck(subscriptionId), ackDelayMs);
        state.timer.unref?.();
      }
    },
    closed(subscriptionId, lastSafeCursor) {
      dropAck(subscriptionId);
      if (subscriptionId === hostSubscriptionId) {
        hostSubscriptionId = null;
        const startedIn = generation;
        subscribe({ scope: "host", after: lastSafeCursor })
          .then((id) => {
            if (startedIn === generation) hostSubscriptionId = id;
            else unsubscribe(id);
          })
          .catch((error) => log("warn", "host scope resubscribe failed", error));
        return;
      }
      const owner = subscriptionOwner(subscriptionId);
      if (!owner) return;
      const slot = slots.get(owner);
      if (!slot) return;
      slot.subscriptionId = null;
      void open(owner, slot, lastSafeCursor);
    },
    isSubscribed(hostSessionId) {
      return slots.has(hostSessionId);
    },
    reset() {
      generation += 1;
      for (const state of acks.values()) if (state.timer) clearTimeout(state.timer);
      acks.clear();
      slots.clear();
      statuses.clear();
      hostSubscriptionId = null;
    },
  };
}
