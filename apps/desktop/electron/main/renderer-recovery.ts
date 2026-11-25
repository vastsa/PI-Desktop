export type RendererGoneDetails = Readonly<{
  reason: string;
  exitCode: number;
}>;

export type RendererRecoveryDependencies = Readonly<{
  isCurrentWindow: boolean;
  quitting: boolean;
  windowCloseAccepted: boolean;
  windowDestroyed: boolean;
  webContentsDestroyed: boolean;
  reload: () => void;
  log: (details: RendererGoneDetails, reloaded: boolean) => void;
}>;

/**
 * Minimum milliseconds between automatic reloads. A renderer that crashes
 * again within this window is still reloaded, but the reload is delayed so
 * the process is not spinning in a tight crash loop.
 */
const CRASH_COOLDOWN_MS = 2_000;

/**
 * Maximum consecutive reloads for a renderer that keeps crashing. Once a
 * renderer crashes this many times without staying up long enough to reset
 * the counter, automatic recovery stops: the previous unbounded loop kept
 * reloading every cooldown interval forever (observed as 10,000+ renderer
 * crashes per day on some Windows GPU setups) while the window never became
 * visible. Stopping lets the user quit or restart instead of burning CPU.
 */
const MAX_CONSECUTIVE_RELOADS = 5;

/** Uptime since the last reload that resets the consecutive-crash counter. */
const RECOVERY_WINDOW_MS = 30_000;

/** Tracks the last reload timestamp per recovery call site. */
let lastReloadTimestamp = 0;

/** Consecutive reloads without a successful recovery window in between. */
let consecutiveReloads = 0;

/**
 * Reset internal cooldown state. Exposed exclusively for deterministic tests;
 * production code must never call this.
 */
export function _resetCooldownForTest(): void {
  lastReloadTimestamp = 0;
  consecutiveReloads = 0;
}

/** Reload an unexpectedly exited renderer while its owning app window is live. */
export function recoverRendererAfterGone(
  details: RendererGoneDetails,
  dependencies: RendererRecoveryDependencies,
): boolean {
  const canRecover =
    details.reason !== "clean-exit" &&
    dependencies.isCurrentWindow &&
    !dependencies.quitting &&
    !dependencies.windowCloseAccepted &&
    !dependencies.windowDestroyed &&
    !dependencies.webContentsDestroyed;

  const now = Date.now();
  const elapsed = now - lastReloadTimestamp;
  lastReloadTimestamp = now;

  // A renderer that stayed up beyond the recovery window recovered
  // successfully; only rapid consecutive crashes count toward the cap.
  if (elapsed >= RECOVERY_WINDOW_MS) consecutiveReloads = 0;
  const shouldReload = canRecover && consecutiveReloads < MAX_CONSECUTIVE_RELOADS;
  if (shouldReload) consecutiveReloads += 1;

  dependencies.log(details, shouldReload);
  if (!shouldReload) return false;

  if (elapsed < CRASH_COOLDOWN_MS) {
    // Delay the reload to avoid a tight crash loop. The timer is short
    // enough that the user sees a brief blank rather than a frozen app.
    setTimeout(() => dependencies.reload(), CRASH_COOLDOWN_MS - elapsed);
  } else {
    dependencies.reload();
  }

  return true;
}
