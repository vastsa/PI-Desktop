import { shell } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "@pi-desktop/shared";
import type { BrowserWindow } from "electron";
import type { IpcRegistrar } from "./types";

export type DiagnosticsIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  stripWinLongPrefix: (path: string) => string;
  isDeveloperMode: () => boolean;
  getMainWindow: () => BrowserWindow | null;
};

/** Register developer diagnostics and log navigation channels. */
export function registerDiagnosticsIpc({
  registrar,
  dataDir,
  stripWinLongPrefix,
  isDeveloperMode,
  getMainWindow,
}: DiagnosticsIpcDependencies): void {
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, fn);
  };
  handle(IPC.invoke.logOpenFolder, async () => {
    const logs = join(dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    await shell.openPath(stripWinLongPrefix(logs));
    return { ok: true, path: logs };
  });

  handle(IPC.invoke.devtoolsToggle, async (input: unknown) => {
    if (!isDeveloperMode()) throw new Error("developer mode is disabled");
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("window unavailable");
    }
    const contents = mainWindow.webContents;
    const desired = (input as { open?: unknown } | null)?.open;
    const open =
      typeof desired === "boolean" ? desired : !contents.isDevToolsOpened();
    if (open) contents.openDevTools({ mode: "detach" });
    else contents.closeDevTools();
    return { open };
  });
}

