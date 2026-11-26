/**
 * The one decision behind the window toggle (D438): the merged
 * `toggleWindow` shortcut and its menu item either hide the window the user is
 * looking at, or bring the window back.
 *
 * Split out of `bootstrap/app-lifecycle.ts` because the choice is the rule; the
 * lifecycle module only supplies the live `BrowserWindow`. The counterpart of
 * `hide` is deliberately `Window.hide()` rather than `Window.close()`: hiding
 * must not enter the close path, which on Windows/Linux can raise the
 * close-behaviour prompt and can quit the app.
 */
export type WindowVisibilitySnapshot = {
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
};

/** `hide` for a window the user is looking at, `show` for anything else. */
export type MainWindowActivationTarget = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isAlwaysOnTop(): boolean;
  isFocused(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  setAlwaysOnTop(value: boolean): void;
};

/** An explicit activation request; the OS can still decline keyboard focus. */
export function activateMainWindowTarget(
  window: MainWindowActivationTarget | null,
  platform: NodeJS.Platform,
): { focused: boolean } {
  if (!window || window.isDestroyed()) return { focused: false };
  if (window.isMinimized()) window.restore();
  if (window.isDestroyed()) return { focused: false };
  const temporarilyTopmost = platform === "win32" && !window.isAlwaysOnTop();
  try {
    if (temporarilyTopmost) window.setAlwaysOnTop(true);
    window.show();
    if (!window.isDestroyed()) window.focus();
  } finally {
    if (temporarilyTopmost && !window.isDestroyed()) window.setAlwaysOnTop(false);
  }
  return { focused: !window.isDestroyed() && window.isFocused() };
}

export function windowToggleAction(
  window: WindowVisibilitySnapshot,
): "hide" | "show" {
  return window.isVisible() && !window.isMinimized() && window.isFocused()
    ? "hide"
    : "show";
}
