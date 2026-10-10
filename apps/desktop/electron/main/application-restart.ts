import { app } from "electron";
import { writeFileSync } from "node:fs";

/** Request a restart without orphaning the development renderer server. */
export function relaunchApplication(args?: string[]): void {
  const restartFile = process.env.PI_DESKTOP_DEV_RESTART_FILE;
  // Completes synchronously so callers can fail before committing live restart
  // state. Packaged production uses `app.relaunch`; branded development
  // (`PI_DESKTOP_DEV=1`) and unpackaged runs hand off through the restart file.
  if (restartFile && (process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged)) {
    // The launcher consumes this after normal shutdown, then starts both Vite
    // and Electron. Native relaunch would retain a dead ELECTRON_RENDERER_URL.
    writeFileSync(restartFile, JSON.stringify(args ?? process.argv.slice(1)), "utf8");
    return;
  }
  if (args) app.relaunch({ args });
  else app.relaunch();
}
