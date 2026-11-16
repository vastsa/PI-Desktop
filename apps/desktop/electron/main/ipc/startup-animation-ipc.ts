import { shell } from "electron";
import { mkdir } from "node:fs/promises";
import { IPC } from "@pi-desktop/shared";
import type { StartupAnimationStatus } from "@pi-desktop/shared";
import {
  resolveStartupAnimation,
  startupAnimationDirectory,
} from "../startup-animation";
import type { IpcRegistrar } from "./types";

export type StartupAnimationIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  stripWinLongPrefix: (path: string) => string;
};

/**
 * Channels behind the Appearance row for the boot animation (D679).
 *
 * The status is re-scanned per call rather than reported from the launch's own
 * resolution, because the row's job is to say what the *next* launch will play:
 * a user who just dropped a file in has not restarted yet, and a row that
 * reported the running launch would call their new file missing.
 *
 * Neither channel returns a filesystem path. "Open folder" hands the directory
 * to the OS from the main process, so the renderer learns the file's name at
 * most — never where the data directory is.
 */
export function registerStartupAnimationIpc({
  registrar,
  dataDir,
  stripWinLongPrefix,
}: StartupAnimationIpcDependencies): void {
  registrar.handle(IPC.invoke.startupAnimationStatus, async () => {
    // Discovery only: the enabled preference belongs to the toggle beside this
    // row, and a disabled animation must still report the file it would play.
    const resolved = await resolveStartupAnimation({ dataDir, settings: null });
    const status: StartupAnimationStatus = {
      directoryName: startupAnimationDirectory(dataDir).split(/[/\\]/).pop() ?? "",
      fileName: resolved?.descriptor.fileName ?? null,
      byteLength: resolved?.descriptor.byteLength ?? null,
    };
    return status;
  });

  registrar.handle(IPC.invoke.startupAnimationOpenFolder, async () => {
    const directory = startupAnimationDirectory(dataDir);
    // Created on demand so the action always lands somewhere: an installation
    // that never used the feature has no such directory, and sending the user
    // to a missing path is worse than making it.
    await mkdir(directory, { recursive: true });
    await shell.openPath(stripWinLongPrefix(directory));
    return { ok: true };
  });
}
