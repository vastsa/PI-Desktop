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

/** Tracks the last reload timestamp per recovery call site. */
let lastReloadTimestamp = 0;

/**
 * Reset internal cooldown state. Exposed exclusively for deterministic tests;
 * production code must never call this.
 */
export function _resetCooldownForTest(): void {
  lastReloadTimestamp = 0;
}

/** Reload an unexpectedly exited renderer while its owning app window is live. */
export function recoverRendererAfterGone(
  details: RendererGoneDetails,
  dependencies: RendererRecoveryDependencies,
): boolean {
  const shouldReload =
    details.reason !== "clean-exit" &&
    dependencies.isCurrentWindow &&
    !dependencies.quitting &&
    !dependencies.windowCloseAccepted &&
    !dependencies.windowDestroyed &&
    !dependencies.webContentsDestroyed;

  dependencies.log(details, shouldReload);
  if (!shouldReload) return false;

  const now = Date.now();
  const elapsed = now - lastReloadTimestamp;
  lastReloadTimestamp = now;

  if (elapsed < CRASH_COOLDOWN_MS) {
    // Delay the reload to avoid a tight crash loop. The timer is short
    // enough that the user sees a brief blank rather than a frozen app.
    setTimeout(() => dependencies.reload(), CRASH_COOLDOWN_MS - elapsed);
  } else {
    dependencies.reload();
  }

  return true;
}
