import type { Logger } from "../logger";

/**
 * Teardown for long-lived main-process services that must outlive a
 * cancelled quit.
 *
 * `before-quit` is not a shutdown signal: the shutdown handler prevents the
 * first one to ask for confirmation, and the user can cancel, after which the
 * app keeps running. A service that stopped itself from its own `before-quit`
 * listener would then stay stopped for the rest of the process lifetime
 * (issue #2048: the scheduled-task runner went silent until a restart).
 * Services register here instead; the shutdown handler runs the listeners
 * once the quit is committed.
 */
const listeners = new Set<() => void>();
let ran = false;

/** Register teardown for a committed quit. Returns an unregister function. */
export function onConfirmedQuit(listener: () => void): () => void {
  if (ran) {
    listener();
    return () => undefined;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Run every registered teardown exactly once. Called by the shutdown handler
 * after the quit can no longer be cancelled. A failing listener is reported
 * and does not keep the remaining services alive.
 */
export function runConfirmedQuitTeardown(logger: Pick<Logger, "app">): void {
  if (ran) return;
  ran = true;
  const pending = [...listeners];
  listeners.clear();
  for (const listener of pending) {
    try {
      listener();
    } catch (error) {
      logger.app("lifecycle", "warn", "quit teardown failed", { data: String(error) });
    }
  }
}

/** Test seam: forget registrations and the committed state between cases. */
export function resetConfirmedQuitForTests(): void {
  listeners.clear();
  ran = false;
}
