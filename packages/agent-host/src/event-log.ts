import type { RacpCursor, RacpEventEnvelope, RacpEventKind, RacpLimits } from "@pi-desktop/shared";
import { RACP_DEFAULT_LIMITS, isDurableEventKind } from "@pi-desktop/shared";

import { racpError, type RacpError } from "./errors.js";
import type { Clock, IdSource } from "./ports.js";

/** What a producer hands to the log: everything the Host does not allocate. */
export type EventDraft = {
  scope: "session" | "host";
  sessionId?: string;
  turnId?: string;
  revision: number;
  kind: RacpEventKind;
  parentToolCallId?: string;
  agentName?: string;
  payload: unknown;
  occurredAt?: string;
};

export type Retention = { maxEvents: number; maxAgeMs: number };

export type ReplayDecision =
  | { status: "live" }
  | { status: "replay"; events: RacpEventEnvelope[] }
  | { status: "resync"; reason: "epoch" | "evicted" | "ahead" };

/**
 * One durable event stream: a Session's, or the Host's own. Durable events
 * get the next `sequence` inside this stream's `epoch`; ephemeral events get
 * `afterSequence` and are never retained (spec §5.3, §8).
 */
export class EventStream {
  readonly epoch: string;
  private sequence = 0;
  private readonly durable: Array<{ envelope: RacpEventEnvelope; appendedAt: number }> = [];

  constructor(
    epoch: string,
    private readonly retention: Retention,
    private readonly clock: Clock,
    private readonly ids: IdSource,
  ) {
    this.epoch = epoch;
  }

  get lastSequence(): number {
    return this.sequence;
  }

  cursor(): RacpCursor {
    return { epoch: this.epoch, sequence: this.sequence };
  }

  /** Oldest durable sequence still retained, or `null` when nothing is. */
  get oldestRetained(): number | null {
    return this.durable.length === 0 ? null : (this.durable[0]!.envelope.sequence ?? null);
  }

  append(draft: EventDraft): RacpEventEnvelope {
    const now = this.clock.now();
    const durable = isDurableEventKind(draft.kind);
    const { occurredAt, ...rest } = draft;
    const envelope: RacpEventEnvelope = {
      ...rest,
      eventId: this.ids.next("evt"),
      epoch: this.epoch,
      occurredAt: occurredAt ?? new Date(now).toISOString(),
      ...(durable ? { sequence: this.sequence + 1 } : { afterSequence: this.sequence }),
    };
    if (durable) {
      this.sequence += 1;
      this.durable.push({ envelope, appendedAt: now });
      this.evict(now);
    }
    return envelope;
  }

  private evict(now: number): void {
    while (this.durable.length > this.retention.maxEvents) this.durable.shift();
    while (this.durable.length > 0 && now - this.durable[0]!.appendedAt > this.retention.maxAgeMs) {
      this.durable.shift();
    }
  }

  /** Decide how a subscriber that presents `after` catches up (spec §8). */
  replay(after: RacpCursor | undefined): ReplayDecision {
    if (!after) return { status: "live" };
    if (after.epoch !== this.epoch) return { status: "resync", reason: "epoch" };
    if (after.sequence > this.sequence) return { status: "resync", reason: "ahead" };
    if (after.sequence === this.sequence) return { status: "replay", events: [] };
    const oldest = this.oldestRetained;
    // Every event with sequence > after must still be retained; the first one
    // needed is after + 1.
    if (oldest === null || oldest > after.sequence + 1) return { status: "resync", reason: "evicted" };
    return {
      status: "replay",
      events: this.durable
        .filter((entry) => (entry.envelope.sequence ?? 0) > after.sequence)
        .map((entry) => entry.envelope),
    };
  }
}

export type SubscriptionSink = {
  deliver(envelope: RacpEventEnvelope): void;
  /** Called once when the Host closes the subscription, e.g. `CLIENT_TOO_SLOW`. */
  close(error: RacpError, lastSafeCursor: RacpCursor): void;
};

export type SubscribeParams = {
  scope: "session" | "host";
  sessionId?: string;
  after?: RacpCursor;
  /** Durable events delivered but not yet acknowledged before the Host
   * considers the subscriber too slow. */
  maxOutstanding?: number;
};

export type SubscribeResult = {
  subscriptionId: string;
  scope: "session" | "host";
  sessionId?: string;
  starting: RacpCursor;
  replayComplete: boolean;
  resyncReason?: "epoch" | "evicted" | "ahead";
};

type Subscription = {
  id: string;
  scope: "session" | "host";
  sessionId?: string;
  sink: SubscriptionSink;
  maxOutstanding: number;
  outstanding: number;
  lastDelivered: RacpCursor;
};

/**
 * Per-session and host-scope streams plus bounded fan-out. Every subscriber
 * keeps an outstanding count of durable events it has not acknowledged;
 * ephemeral events are dropped first, and a durable event that would exceed
 * the bound closes the subscription with `CLIENT_TOO_SLOW` and a resumable
 * cursor instead of losing anything (spec §8).
 */
export class EventHub {
  private readonly streams = new Map<string, EventStream>();
  private readonly host: EventStream;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly retention: Retention;
  private readonly defaultMaxOutstanding: number;

  constructor(
    private readonly deps: { clock: Clock; ids: IdSource; limits?: Partial<RacpLimits> },
  ) {
    const limits = { ...RACP_DEFAULT_LIMITS, ...deps.limits };
    this.retention = { maxEvents: limits.replayWindowEvents, maxAgeMs: limits.replayWindowMs };
    this.defaultMaxOutstanding = 1000;
    this.host = new EventStream(deps.ids.next("ep"), this.retention, deps.clock, deps.ids);
  }

  stream(sessionId: string): EventStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = new EventStream(this.deps.ids.next("ep"), this.retention, this.deps.clock, this.deps.ids);
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  hostStream(): EventStream {
    return this.host;
  }

  /** Append to the right stream and fan out. Returns the allocated envelope. */
  publish(draft: EventDraft): RacpEventEnvelope {
    const stream = draft.scope === "host" ? this.host : this.stream(requireSession(draft));
    const envelope = stream.append(draft);
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.scope !== draft.scope) continue;
      if (draft.scope === "session" && subscription.sessionId !== draft.sessionId) continue;
      this.deliver(subscription, envelope);
    }
    return envelope;
  }

  subscribe(params: SubscribeParams, sink: SubscriptionSink): SubscribeResult {
    const stream = params.scope === "host" ? this.host : this.stream(requireSessionId(params.sessionId));
    const id = this.deps.ids.next("sub");
    const subscription: Subscription = {
      id,
      scope: params.scope,
      sessionId: params.sessionId,
      sink,
      maxOutstanding: params.maxOutstanding ?? this.defaultMaxOutstanding,
      outstanding: 0,
      lastDelivered: params.after ?? stream.cursor(),
    };
    const decision = stream.replay(params.after);
    this.subscriptions.set(id, subscription);
    let replayComplete = true;
    let resyncReason: SubscribeResult["resyncReason"];
    if (decision.status === "replay") {
      for (const envelope of decision.events) this.deliver(subscription, envelope);
    } else if (decision.status === "resync") {
      replayComplete = false;
      resyncReason = decision.reason;
      subscription.lastDelivered = stream.cursor();
    } else {
      subscription.lastDelivered = stream.cursor();
    }
    return {
      subscriptionId: id,
      scope: params.scope,
      sessionId: params.sessionId,
      starting: { epoch: stream.epoch, sequence: subscription.lastDelivered.sequence + 1 },
      replayComplete,
      ...(resyncReason ? { resyncReason } : {}),
    };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /** The subscriber applied every durable event up to `sequence`. */
  ack(subscriptionId: string, sequence: number): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (sequence >= subscription.lastDelivered.sequence) subscription.outstanding = 0;
    else subscription.outstanding = Math.max(0, subscription.lastDelivered.sequence - sequence);
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private deliver(subscription: Subscription, envelope: RacpEventEnvelope): void {
    if (!this.subscriptions.has(subscription.id)) return;
    const durable = typeof envelope.sequence === "number";
    if (!durable) {
      // Ephemeral events are replaceable; a lagging client just misses them.
      if (subscription.outstanding >= subscription.maxOutstanding / 2) return;
      subscription.sink.deliver(envelope);
      return;
    }
    if (subscription.outstanding >= subscription.maxOutstanding) {
      this.subscriptions.delete(subscription.id);
      subscription.sink.close(
        racpError("CLIENT_TOO_SLOW", "subscriber did not acknowledge durable events in time", {
          details: { lastSafeCursor: subscription.lastDelivered },
        }),
        subscription.lastDelivered,
      );
      return;
    }
    subscription.outstanding += 1;
    subscription.lastDelivered = { epoch: envelope.epoch, sequence: envelope.sequence! };
    subscription.sink.deliver(envelope);
  }
}

function requireSession(draft: EventDraft): string {
  return requireSessionId(draft.sessionId);
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw racpError("INVALID_ARGUMENT", "sessionId is required for session-scoped events");
  return sessionId;
}
