/**
 * Restart supervision for the two runtime children (host-core, agent sidecar).
 *
 * The policy is the one Electron Main has always applied (spec 07 §4):
 * exponential backoff `0.5s → 1s → 2s` capped at 4s, at most three restarts
 * per two-minute window per child, single-flight per child, and never after
 * shutdown began. The supervisor owns only the loop; how a child is started,
 * what happens after it came back, and how an outcome is reported belong to
 * the embedding host, so Electron Main and the headless `pi-host` share one
 * implementation of the policy without sharing their renderer or logger.
 */
export type SupervisedKind = "host" | "sidecar";

export type RestartPolicy = {
  /** Restarts allowed inside one window before the child is declared fatal. */
  maxRestartsPerWindow: number;
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestartsPerWindow: 3,
  windowMs: 120_000,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

export type SupervisorEvent =
  | { kind: SupervisedKind; phase: "restarting"; attempt: number; delayMs: number }
  | { kind: SupervisedKind; phase: "restart_failed"; attempt: number; error: unknown }
  | { kind: SupervisedKind; phase: "restarted"; attempt: number }
  | { kind: SupervisedKind; phase: "fatal"; reason: "limit" | "unrecoverable"; error?: unknown };

export type RuntimeSupervisorOptions = {
  /** Start (or restart) one child and leave it wired; rejects when it cannot come up. */
  start: Record<SupervisedKind, () => Promise<void>>;
  /** Runs after a successful start inside the same attempt; a failure counts as a failed restart. */
  afterRestart?: (kind: SupervisedKind) => Promise<void> | void;
  /**
   * True when an error means the child can never come back on its own (a data
   * directory newer than the build, an unsupported glibc). The loop stops on
   * the first such failure instead of burning the restart budget.
   */
  isUnrecoverable?: (error: unknown) => boolean;
  isShuttingDown?: () => boolean;
  onEvent?: (event: SupervisorEvent) => void;
  policy?: Partial<RestartPolicy>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type WindowState = { count: number; windowStart: number };

export class RuntimeSupervisor {
  private readonly policy: RestartPolicy;
  private readonly windows: Record<SupervisedKind, WindowState> = {
    host: { count: 0, windowStart: 0 },
    sidecar: { count: 0, windowStart: 0 },
  };
  private readonly inFlight: Record<SupervisedKind, Promise<void> | null> = {
    host: null,
    sidecar: null,
  };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.policy = { ...DEFAULT_RESTART_POLICY, ...options.policy };
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /** Bring one child back. Concurrent calls for the same child join the running loop. */
  superviseRestart(kind: SupervisedKind): Promise<void> {
    const existing = this.inFlight[kind];
    if (existing) return existing;
    const run = this.loop(kind).finally(() => {
      if (this.inFlight[kind] === run) this.inFlight[kind] = null;
    });
    this.inFlight[kind] = run;
    return run;
  }

  /** The delay before restart attempt `attempt` (1-based) under the policy. */
  delayForAttempt(attempt: number): number {
    return Math.min(this.policy.baseDelayMs * 2 ** (attempt - 1), this.policy.maxDelayMs);
  }

  private shuttingDown(): boolean {
    return this.options.isShuttingDown?.() ?? false;
  }

  private emit(event: SupervisorEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // A reporting failure must not stop the child from coming back.
    }
  }

  private async loop(kind: SupervisedKind): Promise<void> {
    const state = this.windows[kind];
    while (!this.shuttingDown()) {
      const now = this.now();
      if (now - state.windowStart > this.policy.windowMs) {
        state.windowStart = now;
        state.count = 0;
      }
      state.count += 1;
      if (state.count > this.policy.maxRestartsPerWindow) {
        this.emit({ kind, phase: "fatal", reason: "limit" });
        return;
      }
      const attempt = state.count;
      const delayMs = this.delayForAttempt(attempt);
      this.emit({ kind, phase: "restarting", attempt, delayMs });
      await this.sleep(delayMs);
      if (this.shuttingDown()) return;
      try {
        await this.options.start[kind]();
        await this.options.afterRestart?.(kind);
        this.emit({ kind, phase: "restarted", attempt });
        return;
      } catch (error) {
        if (this.options.isUnrecoverable?.(error)) {
          this.emit({ kind, phase: "fatal", reason: "unrecoverable", error });
          return;
        }
        this.emit({ kind, phase: "restart_failed", attempt, error });
      }
    }
  }
}
