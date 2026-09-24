/**
 * Renderer startup watchdog.
 *
 * The shell paints only once `bootstrap` publishes the initial state. A startup
 * read that never settles therefore leaves the window on the boot surface
 * forever, with no menu, no data, and nothing the user can act on (issue #831).
 * This module owns the two boundaries of that wait so the window can always fall
 * back to a surface the user can operate.
 *
 * Both bounds are deliberately far above a healthy boot: the splash is designed
 * around a sub-second boot, and the slowest realistic backend answer is the
 * main↔service RPC ceiling. See `STARTUP_STALLED_MS`.
 */

/** Boot phases the window reports while it still has no initial state. */
export type StartupPhase = "starting" | "slow" | "stalled";

/**
 * When to tell the user the boot is slow, without calling it a failure.
 *
 * A healthy boot finishes in about a second (the splash's own minimum dwell is
 * 420ms), so anything past this is a real wait — and the phase exists so the logs
 * can be collected *before* the user gives up on a stuck launch instead of after
 * force-quitting it. It stays far below every failure bound below, so it can
 * never read as an error by itself.
 */
export const STARTUP_SLOW_HINT_MS = 30_000;

/**
 * When the boot is treated as stalled.
 *
 * The renderer's startup reads go to the local service through the main process,
 * and `DEFAULT_RPC_TIMEOUT_MS` (130s, packages/shared/src/rpc-timeouts.ts) is the
 * longest a single one of them can stay unanswered before it rejects on its own.
 * Below that ceiling every read is still legitimately "in flight", so declaring
 * the boot stalled any earlier would turn a slow-but-successful launch into an
 * error screen. This bound is that ceiling plus a margin for the reads to settle
 * and for the store to publish.
 */
export const STARTUP_STALLED_MS = 180_000;

/** The two timers a watchdog needs; injectable so tests need no real clock. */
export type StartupWatchdogScheduler = {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type StartupWatchdog = {
  /** Arm the bounds. Safe to call once per wait. */
  start: () => void;
  /** Disarm every pending bound. Idempotent. */
  stop: () => void;
};

/**
 * Announces each phase as its bound passes.
 *
 * Two one-shot timers rather than one interval: a phase is a boundary crossing,
 * not a poll, and a watchdog that also reported "starting" would republish state
 * on every tick. Nothing here decides whether the boot failed — the caller keeps
 * the underlying startup promise running, so a slow launch that does finish
 * still takes the window over.
 */
export function createStartupWatchdog({
  onPhase,
  slowMs = STARTUP_SLOW_HINT_MS,
  stalledMs = STARTUP_STALLED_MS,
  scheduler,
}: {
  onPhase: (phase: StartupPhase) => void;
  slowMs?: number;
  stalledMs?: number;
  scheduler: StartupWatchdogScheduler;
}): StartupWatchdog {
  let handles: unknown[] = [];
  let stopped = false;
  return {
    start: () => {
      if (stopped || handles.length > 0) return;
      handles = [
        scheduler.setTimeout(() => {
          if (!stopped) onPhase("slow");
        }, slowMs),
        scheduler.setTimeout(() => {
          if (!stopped) onPhase("stalled");
        }, stalledMs),
      ];
    },
    stop: () => {
      stopped = true;
      for (const handle of handles) scheduler.clearTimeout(handle);
      handles = [];
    },
  };
}

/** Facts about a stalled boot that the renderer knows without another IPC call. */
export type StartupDiagnosticsInput = {
  phase: StartupPhase;
  elapsedMs: number;
  platform: string;
  locale?: string | null;
  appVersion?: string | null;
  /** Last error the store published for the startup, if any. */
  error?: string | null;
  /** Component the main process reported as down, if it did. */
  downComponent?: string | null;
  downMessage?: string | null;
};

/**
 * The report behind "copy diagnostics".
 *
 * Built only from what the renderer already holds: asking the local service for
 * more would repeat the very call that is not answering. Plain text so it can be
 * pasted into a bug report as-is, and limited to facts the user already saw — no
 * session content, no file paths, no credentials. The error and reported-down
 * text it carries is the app's own message, the same one the user is looking at.
 */
export function buildStartupDiagnostics(input: StartupDiagnosticsInput): string {
  const seconds = Math.round(input.elapsedMs / 1000);
  const lines = [
    "PI-Desktop startup diagnostics",
    `phase: ${input.phase}`,
    `waited: ${seconds}s`,
    `platform: ${input.platform}`,
    `locale: ${input.locale ?? "unknown"}`,
    `app version: ${input.appVersion ?? "unknown"}`,
    `last startup error: ${input.error ?? "none"}`,
    `reported down: ${
      input.downComponent
        ? `${input.downComponent}${input.downMessage ? ` (${input.downMessage})` : ""}`
        : "none"
    }`,
  ];
  return lines.join("\n");
}
