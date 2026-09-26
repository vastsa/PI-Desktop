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
  cursorFor?(sessionId: string): RacpCursor | undefined;
  cursorForHost?(): RacpCursor | undefined;
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
  onSessionRecovery?: (recovery: RemoteSubscriptionRecovery) => Promise<unknown> | unknown;
  onHostRecovery?: (reason: RemoteSubscriptionRecovery["reason"]) => Promise<unknown> | unknown;
};

export interface RemoteSubscriptions {
  /** Subscribe to the host scope; held for the connection's lifetime. */
  openHost(after?: RacpCursor): Promise<void>;
  /**
   * Make sure `hostSessionId` streams, evicting the least recently used idle
   * session when the cap is reached. `after` resumes from an attach cursor.
   */
  touch(hostSessionId: string, after?: RacpCursor): Promise<RemoteSubscriptionRecovery | undefined>;
  /** Record a session's status; busy sessions are never evicted. */
  noteStatus(hostSessionId: string, status: RacpSessionStatus | undefined): void;
  /** Drop a session's subscription (the session is gone). */
  release(hostSessionId: string): Promise<void>;
  /** Feed every delivered envelope; drives the throttled acks. */
  observe(envelope: RacpEventEnvelope): void;
  /** Establish a new safe baseline from an authoritative session snapshot. */
  checkpoint(hostSessionId: string, cursor: RacpCursor): void;
  /** The host closed a subscription; reopen it from `lastSafeCursor`. */
  closed(subscriptionId: string, lastSafeCursor: RacpCursor): void;
  /** Restore retained scopes after the transport reconnects. */
  reconnect(): Promise<RemoteSubscriptionRecovery[]>;
  /** Whether `hostSessionId` currently holds a subscription. */
  isSubscribed(hostSessionId: string): boolean;
  /** Forget every subscription (the transport went away). */
  reset(): void;
}

export type RemoteSubscriptionRecovery = {
  hostSessionId: string;
  reason: "epoch" | "evicted" | "ahead";
};

const DEFAULT_MAX = 8;
const DEFAULT_ACK_EVERY = 64;
const DEFAULT_ACK_DELAY_MS = 250;
/** Statuses whose session holds its slot until it settles. */
const BUSY: ReadonlySet<string> = new Set(["running", "waiting_permission"]);

type Slot = {
  subscriptionId: string | null;
  /** Last event or attach snapshot known safe for this session. */
  cursor?: RacpCursor;
  /** Monotonic use stamp; larger is more recent. */
  usedAt: number;
  pending?: Promise<RemoteSubscriptionRecovery | undefined>;
};

type SubscribeResult = {
  subscriptionId: string;
  starting?: RacpCursor;
  replayComplete?: boolean;
  resyncReason?: "epoch" | "evicted" | "ahead";
};

type AckState = { sequence: number; unacked: number; timer: ReturnType<typeof setTimeout> | null };

export function createRemoteSubscriptions(options: RemoteSubscriptionsOptions): RemoteSubscriptions {
  const { client } = options;
  const log = options.log ?? (() => undefined);
  const capacity = Math.max(1, (options.maxSubscriptions ?? DEFAULT_MAX) - 1);
  const ackEvery = Math.max(1, options.ackEvery ?? DEFAULT_ACK_EVERY);
  const ackDelayMs = options.ackDelayMs ?? DEFAULT_ACK_DELAY_MS;

  let hostSubscriptionId: string | null = null;
  let hostCursor: RacpCursor | undefined;
  const slots = new Map<string, Slot>();
  const statuses = new Map<string, string>();
  const acks = new Map<string, AckState>();
  let clock = 0;
  let generation = 0;
  let restoring: Promise<RemoteSubscriptionRecovery[]> | null = null;

  const advanceCursor = (
    current: RacpCursor | undefined,
    candidate: RacpCursor,
  ): RacpCursor => {
    if (current?.epoch === candidate.epoch && current.sequence > candidate.sequence) return current;
    return candidate;
  };

  const subscriptionCursor = (result: SubscribeResult): RacpCursor | undefined =>
    result.starting
      ? { epoch: result.starting.epoch, sequence: Math.max(0, result.starting.sequence - 1) }
      : undefined;

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

  const subscribe = async (params: Record<string, unknown>): Promise<SubscribeResult> => {
    return client.request<SubscribeResult>("events/subscribe", params);
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

  const open = (
    hostSessionId: string,
    slot: Slot,
    after?: RacpCursor,
  ): Promise<RemoteSubscriptionRecovery | undefined> => {
    const startedIn = generation;
    if (after) slot.cursor = advanceCursor(slot.cursor, after);
    const pending = subscribe({
      scope: "session",
      sessionId: hostSessionId,
      ...(after ? { after } : {}),
    })
      .then((result) => {
        if (startedIn !== generation || slots.get(hostSessionId) !== slot) {
          // Released or reset while subscribing: give the slot straight back.
          unsubscribe(result.subscriptionId);
          return undefined;
        }
        slot.subscriptionId = result.subscriptionId;
        const baseline = subscriptionCursor(result);
        if (baseline) slot.cursor = advanceCursor(slot.cursor, baseline);
        return result.replayComplete === false
          ? { hostSessionId, reason: result.resyncReason ?? "epoch" }
          : undefined;
      })
      .catch((error) => {
        if (slots.get(hostSessionId) === slot && errorCode(error) !== "HOST_DISCONNECTED") {
          slots.delete(hostSessionId);
        }
        log("warn", `events/subscribe failed for session ${hostSessionId}`, error);
        return undefined;
      })
      .finally(() => {
        if (slot.pending === pending) delete slot.pending;
      });
    slot.pending = pending;
    return pending;
  };

  const clearAcks = () => {
    for (const state of acks.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    acks.clear();
  };

  return {
    async openHost(after) {
      const startedIn = generation;
      try {
        const result = await subscribe({
          scope: "host",
          ...(after ? { after } : {}),
        });
        if (startedIn === generation) {
          hostSubscriptionId = result.subscriptionId;
          const baseline = subscriptionCursor(result);
          if (baseline) hostCursor = advanceCursor(hostCursor, baseline);
          else if (after) hostCursor = advanceCursor(hostCursor, after);
        }
      } catch (error) {
        log("warn", "events/subscribe host scope failed", error);
      }
    },
    async touch(hostSessionId, after) {
      if (restoring) {
        await restoring;
        return this.touch(hostSessionId, after);
      }
      const existing = slots.get(hostSessionId);
      if (existing) {
        existing.usedAt = ++clock;
        if (after) existing.cursor = advanceCursor(existing.cursor, after);
        if (existing.pending) return existing.pending;
        else if (!existing.subscriptionId) {
          return open(
            hostSessionId,
            existing,
            existing.cursor ?? client.cursorFor?.(hostSessionId),
          );
        }
        return undefined;
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
      return open(hostSessionId, slot, after ?? client.cursorFor?.(hostSessionId));
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
      const cursor = { epoch: envelope.epoch, sequence: envelope.sequence };
      if (envelope.scope === "host") {
        hostCursor = advanceCursor(hostCursor, cursor);
      } else if (envelope.sessionId !== undefined) {
        const slot = slots.get(envelope.sessionId);
        if (slot) slot.cursor = advanceCursor(slot.cursor, cursor);
      }
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
    checkpoint(hostSessionId, cursor) {
      const slot = slots.get(hostSessionId);
      if (slot) slot.cursor = advanceCursor(slot.cursor, cursor);
    },
    closed(subscriptionId, lastSafeCursor) {
      dropAck(subscriptionId);
      if (subscriptionId === hostSubscriptionId) {
        hostSubscriptionId = null;
        hostCursor = advanceCursor(hostCursor, lastSafeCursor);
        const startedIn = generation;
        subscribe({ scope: "host", after: hostCursor })
          .then(async (result) => {
            if (startedIn !== generation) {
              unsubscribe(result.subscriptionId);
              return;
            }
            hostSubscriptionId = result.subscriptionId;
            const baseline = subscriptionCursor(result);
            if (baseline) hostCursor = advanceCursor(hostCursor, baseline);
            if (result.replayComplete === false) {
              await options.onHostRecovery?.(result.resyncReason ?? "epoch");
            }
          })
          .catch((error) => log("warn", "host scope resubscribe failed", error));
        return;
      }
      const owner = subscriptionOwner(subscriptionId);
      if (!owner) return;
      const slot = slots.get(owner);
      if (!slot) return;
      slot.subscriptionId = null;
      slot.cursor = advanceCursor(slot.cursor, lastSafeCursor);
      void open(owner, slot, slot.cursor)
        .then(async (resync) => {
          if (resync) await options.onSessionRecovery?.(resync);
        })
        .catch((error) =>
          log("warn", `session subscription recovery failed for ${owner}`, error),
        );
    },
    async reconnect() {
      if (restoring) return restoring;
      const startedIn = ++generation;
      clearAcks();
      hostSubscriptionId = null;
      const retained = [...slots.entries()];
      for (const [, slot] of retained) slot.subscriptionId = null;
      const restore = async (): Promise<RemoteSubscriptionRecovery[]> => {
        await Promise.all(
          retained.flatMap(([, slot]) => slot.pending ? [slot.pending] : []),
        );
        if (startedIn !== generation) return [];
        await this.openHost(hostCursor ?? client.cursorForHost?.());
        if (startedIn !== generation) return [];
        const recoveries = await Promise.all(
          retained.map(([sessionId, slot]) =>
            slots.get(sessionId) === slot
              ? open(sessionId, slot, slot.cursor ?? client.cursorFor?.(sessionId))
              : Promise.resolve(undefined),
          ),
        );
        return recoveries.filter((recovery): recovery is RemoteSubscriptionRecovery => recovery !== undefined);
      };
      const pending = restore();
      restoring = pending;
      try {
        return await pending;
      } finally {
        if (restoring === pending) restoring = null;
      }
    },
    isSubscribed(hostSessionId) {
      return slots.has(hostSessionId);
    },
    reset() {
      generation += 1;
      clearAcks();
      slots.clear();
      statuses.clear();
      hostSubscriptionId = null;
      hostCursor = undefined;
    },
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { code?: unknown; errorCode?: unknown };
  if (typeof record.code === "string") return record.code;
  return typeof record.errorCode === "string" ? record.errorCode : undefined;
}
