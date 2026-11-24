import type { BrowserWindow } from "electron";

type WindowStateScheduler = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const scheduler: WindowStateScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Keep renderer window chrome aligned with native state after fullscreen settles. */
export function installWindowStateSync(
  window: Pick<BrowserWindow, "on" | "removeListener">,
  sendMaximized: () => void,
  settleMs: number,
  timers: WindowStateScheduler = scheduler,
): void {
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const reportMaximized = () => sendMaximized();
  const scheduleMaximizedResync = () => {
    if (settleTimer) timers.clearTimeout(settleTimer);
    settleTimer = timers.setTimeout(() => {
      settleTimer = null;
      if (!disposed) sendMaximized();
    }, settleMs);
  };
  const dispose = () => {
    disposed = true;
    if (settleTimer) {
      timers.clearTimeout(settleTimer);
      settleTimer = null;
    }
    window.removeListener("maximize", reportMaximized);
    window.removeListener("unmaximize", reportMaximized);
    window.removeListener("enter-full-screen", scheduleMaximizedResync);
    window.removeListener("leave-full-screen", scheduleMaximizedResync);
    window.removeListener("closed", dispose);
  };

  window.on("maximize", reportMaximized);
  window.on("unmaximize", reportMaximized);
  window.on("enter-full-screen", scheduleMaximizedResync);
  window.on("leave-full-screen", scheduleMaximizedResync);
  window.on("closed", dispose);
}
