import type { BrowserWindow } from "electron";

// Electron 43 introduced the `system-context-menu` event, which fires when the
// user right-clicks any `-webkit-app-region: drag` region inside a frameless
// window (win32 + linux). The frameless titlebar's 46 px drag strip is exactly
// such a region.
//
// On Linux/X11 the resulting native GTK menu takes an active pointer grab.
// Dismissing it with a mouse click leaks the grab, and the whole desktop stops
// receiving pointer events until the session is restarted (see issue #511).
// The frameless shell owns its own titlebar controls in the renderer, so this
// native menu adds nothing and its absence returns behavior to the Electron 42
// baseline.
//
// Windows keeps the standard system menu — the crash is X11-specific and the
// menu is the expected win32 chrome for a frameless titlebar.
export function suppressLinuxFramelessSystemMenu(window: BrowserWindow): void {
  if (process.platform !== "linux") return;
  window.on("system-context-menu", (event) => {
    event.preventDefault();
  });
}
