import type { BrowserWindow } from "electron";

// Windows main windows retain their thick frame, so Electron's native
// fullscreen state is authoritative on every supported Windows version.
export function isWindowFullScreen(window: BrowserWindow): boolean {
  return window.isFullScreen();
}

export function setWindowFullScreen(window: BrowserWindow, fullScreen: boolean): void {
  window.setFullScreen(fullScreen);
}
