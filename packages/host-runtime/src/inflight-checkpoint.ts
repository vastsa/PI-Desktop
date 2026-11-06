import type { UiMessage } from "@pi-desktop/shared";

/**
 * Minimum spacing between two checkpoints of the same session (D299). One
 * small file write per interval keeps the cost off the streaming path while
 * bounding what a quit or crash can lose to the last interval of output.
 */
export const INFLIGHT_CHECKPOINT_INTERVAL_MS = 1500;

export type InflightCheckpoint = {
  sessionId: string;
  turnId?: string;
  message: UiMessage;
};

type SessionState = {
  messageId: string;
  lastSavedAt: number;
  pending?: InflightCheckpoint;
  timer?: ReturnType<typeof setTimeout>;
};

/** Whether a streamed assistant message carries anything worth keeping. */
export function isCheckpointableMessage(message: UiMessage): boolean {
  if (message.role !== "assistant") return false;
  return Boolean(
    (message.content || "").trim() || (message.thinking || "").trim(),
  );
}

/**
 * Throttled writer for the assistant reply currently streaming in a session.
 *
 * `observe` is fed every `message_update`; the newest snapshot wins and is
 * written at most once per interval, with a trailing write so the last update
 * of a burst is not lost to the throttle. `settle` drops whatever is pending
 * once the final row is on its way. Issued writes stay tracked until they
 * finish, so shutdown and later turns cannot overtake them.
 */
export class InflightCheckpointer {
  private readonly sessions = new Map<string, SessionState>();
  /** Physical writes outlive settlement of the message that started them. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly save: (checkpoint: InflightCheckpoint) => Promise<unknown>;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(
    save: (checkpoint: InflightCheckpoint) => Promise<unknown>,
    intervalMs = INFLIGHT_CHECKPOINT_INTERVAL_MS,
    now: () => number = Date.now,
  ) {
    this.save = save;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  observe(checkpoint: InflightCheckpoint): void {
    if (this.disposed || !isCheckpointableMessage(checkpoint.message)) return;
    let state = this.sessions.get(checkpoint.sessionId);
    if (!state) {
      state = { messageId: checkpoint.message.id, lastSavedAt: Number.NEGATIVE_INFINITY };
      this.sessions.set(checkpoint.sessionId, state);
    }
    state.messageId = checkpoint.message.id;
    state.pending = checkpoint;
    if (state.timer || this.writes.has(checkpoint.sessionId)) return;
    const due = state.lastSavedAt + this.intervalMs - this.now();
    if (due <= 0) {
      void this.writePending(checkpoint.sessionId);
      return;
    }
    state.timer = setTimeout(() => {
      state!.timer = undefined;
      void this.writePending(checkpoint.sessionId);
    }, due);
    state.timer.unref?.();
  }

  /**
   * Forget the session's pending checkpoint only when it is still the same
   * message. A newer turn that started while the final snapshot was flushing
   * must keep its own checkpoint.
   */
  settleIf(sessionId: string, messageId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.messageId !== messageId) return;
    this.settle(sessionId);
  }

  /** Forget the session's pending checkpoint; its final row is on its way. */
  settle(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.sessions.delete(sessionId);
  }

  /** Sessions with a pending or still-writing snapshot, including settled turns. */
  pendingSessions(): string[] {
    return [...new Set([
      ...this.writes.keys(),
      ...[...this.sessions.entries()]
        .filter(([, state]) => state.pending)
        .map(([sessionId]) => sessionId),
    ])];
  }

  /** Drain the work present at this barrier; callers quiesce producers before shutdown. */
  async flushAll(): Promise<void> {
    await Promise.allSettled(this.pendingSessions().map((sessionId) => this.flush(sessionId)));
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.sessions.clear();
  }

  /** Drain this message's writes without forcing a later reply past its throttle. */
  async flush(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    const messageId = state?.messageId;
    const pending = state?.pending;
    const inFlight = this.writes.get(sessionId);
    if (inFlight) await inFlight;
    if (pending && this.sessions.get(sessionId) === state && state?.messageId === messageId) {
      await this.writePending(sessionId);
    }
  }

  /** Start one write; ordinary streaming keeps the interval between writes. */
  private writePending(sessionId: string): Promise<void> {
    const inFlight = this.writes.get(sessionId);
    if (inFlight) return inFlight;
    const state = this.sessions.get(sessionId);
    if (!state) return Promise.resolve();
    if (!state.pending) return Promise.resolve();
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const checkpoint = state.pending;
    state.pending = undefined;
    state.lastSavedAt = this.now();
    const run = this.save(checkpoint)
      .catch(() => undefined)
      .then(() => {
        this.writes.delete(sessionId);
        // Settlement may have replaced the logical state while this write ran.
        const current = this.sessions.get(sessionId);
        if (current?.pending) this.observe(current.pending);
      });
    this.writes.set(sessionId, run);
    return run;
  }
}
