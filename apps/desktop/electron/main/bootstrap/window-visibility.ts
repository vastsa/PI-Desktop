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
export function windowToggleAction(
  window: WindowVisibilitySnapshot,
): "hide" | "show" {
  return window.isVisible() && !window.isMinimized() && window.isFocused()
    ? "hide"
    : "show";
}
