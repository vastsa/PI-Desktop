import type { BrowserWindow } from "electron";
import { isWindowFullScreen } from "./window-fullscreen.ts";

/** Keep the OS minimum small enough for a side-by-side tile in DIP. */
export function nativeWindowMinimumSize(
  requested: { width: number; height: number },
  workArea: { width: number; height: number },
  platform: NodeJS.Platform,
): { width: number; height: number } {
  // Sequoia places a gutter around native tiles, unlike Windows/X11 halves.
  const tileWidth = Math.floor(workArea.width / 2) - (platform === "darwin" ? 16 : 0);
  return {
    width: Math.max(1, Math.floor(Math.min(requested.width, tileWidth))),
    height: Math.max(1, Math.floor(Math.min(requested.height, workArea.height))),
  };
}

/** Keep the edges locked while a Windows window is maximized. */
export function installMaximizedWindowGuard(
  window: BrowserWindow,
  platform: NodeJS.Platform,
): () => void {
  // AppKit routes both edge dragging and Zoom/Restore through will-resize.
  // On macOS and Linux the window manager owns the resize gesture.
  if (platform !== "win32") return () => {};
  let settledMaximized = window.isMaximized();
  const maximize = () => { settledMaximized = true; };
  const unmaximize = () => { settledMaximized = false; };
  const resize = () => {
    if (!window.isDestroyed() && !window.isMaximized()) settledMaximized = false;
  };
  const preventMaximizedDrag = (event: { preventDefault(): void }) => {
    if (settledMaximized && !window.isDestroyed()) event.preventDefault();
  };
  const dispose = () => {
    window.removeListener("maximize", maximize);
    window.removeListener("unmaximize", unmaximize);
    window.removeListener("resize", resize);
    window.removeListener("will-resize", preventMaximizedDrag);
    window.removeListener("closed", dispose);
  };
  window.on("maximize", maximize);
  window.on("unmaximize", unmaximize);
  window.on("resize", resize);
  window.on("will-resize", preventMaximizedDrag);
  window.once("closed", dispose);
  return dispose;
}


/** Electron suppresses SC_MAXIMIZE for transparent HWNDs, including caption double-click. */
export function installTransparentWindowsMaximize(window: BrowserWindow): () => void {
  const WM_SYSCOMMAND = 0x0112;
  const SC_MAXIMIZE = 0xf030;
  let pending: NodeJS.Immediate | null = null;
  let disposed = false;
  window.hookWindowMessage(WM_SYSCOMMAND, (wParam) => {
    if (wParam.length < 4 || (wParam.readUInt32LE(0) & 0xfff0) !== SC_MAXIMIZE || pending || disposed) return;
    // Let Electron consume the unsupported native command first. Its public
    // maximize API still works for this surface and does not resend SC_MAXIMIZE.
    pending = setImmediate(() => {
      pending = null;
      if (!disposed && !window.isDestroyed() && !window.isMaximized() && !isWindowFullScreen(window)) {
        window.maximize();
      }
    });
  });
  const dispose = () => {
    disposed = true;
    if (pending) clearImmediate(pending);
    pending = null;
    window.removeListener("closed", dispose);
    if (!window.isDestroyed()) window.unhookWindowMessage(WM_SYSCOMMAND);
  };
  window.once("closed", dispose);
  return dispose;
}
