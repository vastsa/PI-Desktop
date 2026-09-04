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
  lastSavedAt: number;
  pending?: InflightCheckpoint;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
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
 * once the final row is on its way: the host's own append supersedes the
 * checkpoint, and a late write is a wasted round trip at best.
 */
export class InflightCheckpointer {
  private readonly sessions = new Map<string, SessionState>();
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
      state = { lastSavedAt: Number.NEGATIVE_INFINITY };
      this.sessions.set(checkpoint.sessionId, state);
    }
    state.pending = checkpoint;
    if (state.timer || state.inFlight) return;
    const due = state.lastSavedAt + this.intervalMs - this.now();
    if (due <= 0) {
      this.flush(checkpoint.sessionId);
      return;
    }
    state.timer = setTimeout(() => {
      state!.timer = undefined;
      this.flush(checkpoint.sessionId);
    }, due);
    state.timer.unref?.();
  }

  /** Forget the session's pending checkpoint; its final row is on its way. */
  settle(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.sessions.delete(sessionId);
  }

  /** Sessions that still have an unsaved snapshot, for a shutdown flush. */
  pendingSessions(): string[] {
    return [...this.sessions.entries()]
      .filter(([, state]) => state.pending)
      .map(([sessionId]) => sessionId);
  }

  /** Write every pending snapshot now, ignoring the interval. */
  async flushAll(): Promise<void> {
    const flushes = this.pendingSessions().map((sessionId) =>
      this.flush(sessionId),
    );
    await Promise.allSettled(flushes);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.sessions.clear();
  }

  /** Write the session's pending snapshot now, ignoring the interval. */
  flush(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return Promise.resolve();
    // A write already running carries an older snapshot; the newer one goes
    // right after it so a shutdown flush ends on the latest text.
    if (state.inFlight) return state.inFlight.then(() => this.flush(sessionId));
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
        // The state object may have been replaced by settle + observe.
        if (this.sessions.get(sessionId) !== state) return;
        state.inFlight = undefined;
        if (state.pending) this.observe(state.pending);
      });
    state.inFlight = run;
    return run;
  }
}
