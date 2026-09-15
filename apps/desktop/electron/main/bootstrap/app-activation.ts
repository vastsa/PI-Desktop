import { app } from "electron";

export type ApplicationActivationDependencies = {
  restoreMainWindow: () => void;
  isQuitting: () => boolean;
  isApplicationBooted: () => boolean;
  hasVisibleWindow: () => boolean;
};

/** Register activation paths that restore the existing application window. */
export function registerApplicationActivation({
  restoreMainWindow,
  isQuitting,
  isApplicationBooted,
  hasVisibleWindow,
}: ApplicationActivationDependencies): void {
  app.on("activate", restoreMainWindow);

  // Launching PI-Desktop again is a request to see the app that is already
  // running, not to start another process. Electron hands that launch to the
  // lock holder, so the visible result matches the tray's Show action.
  app.on("second-instance", restoreMainWindow);

  // macOS can activate the app without emitting `activate` (Cmd+Tab, App
  // Exposé, and Spotlight). Restore only when no window is visible, so opening
  // a plugin surface does not unexpectedly bring the main window forward.
  if (process.platform === "darwin") {
    app.on("did-become-active", () => {
      if (isQuitting() || !isApplicationBooted() || hasVisibleWindow()) return;
      restoreMainWindow();
    });
  }
}
