import type { BrowserWindow } from "electron";

// Electron's Win32 thickFrame:false path fills display.bounds() but leaves
// BrowserWindow.isFullScreen() false. Track that fallback for toggle and state.
const borderlessFullScreen = new WeakSet<BrowserWindow>();

export function isWindowFullScreen(window: BrowserWindow): boolean {
  return borderlessFullScreen.has(window) || window.isFullScreen();
}

export function setWindowFullScreen(
  window: BrowserWindow,
  fullScreen: boolean,
  borderlessWindowsMain: boolean,
): void {
  if (borderlessWindowsMain) {
    if (fullScreen) borderlessFullScreen.add(window);
    else borderlessFullScreen.delete(window);
  }
  window.setFullScreen(fullScreen);
}
