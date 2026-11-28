import { app, dialog, shell } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { Logger } from "../logger";
import {
  createRendererCrashLoopFallback,
  type RendererCrashLoopFallback,
} from "../renderer-crash-loop";

export const DISABLE_GPU_SWITCH = "--disable-gpu";

/**
 * Electron wiring for the #2595 crash-loop fallback. Both exits go through
 * the ordered `before-quit` shutdown with the quit already confirmed, so
 * host-core and running turns are settled before the process ends.
 */
export function createWindowRendererCrashLoopFallback({
  state,
  dataDir,
  logger,
}: Readonly<{
  state: { quitConfirmed: boolean };
  dataDir: string;
  logger: Pick<Logger, "app">;
}>): RendererCrashLoopFallback {
  const quit = () => {
    state.quitConfirmed = true;
    app.quit();
  };
  const showTerminalDialog = async () => {
    const labels = catalogs[resolveLocale(app.getLocale())];
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: labels.rendererCrash.title,
      message: labels.rendererCrash.body,
      buttons: [labels.rendererCrash.openLogs, labels.tray.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      const logs = join(dataDir, "logs");
      mkdirSync(logs, { recursive: true });
      await shell.openPath(logs);
    }
    quit();
  };
  return createRendererCrashLoopFallback({
    // userData is the installation anchor: known before `ready`, where boot
    // reads the marker, and independent of the selected data location.
    markerDir: app.getPath("userData"),
    logger,
    relaunch: () => {
      const args = process.argv.slice(1);
      app.relaunch({ args: args.includes(DISABLE_GPU_SWITCH) ? args : [...args, DISABLE_GPU_SWITCH] });
      quit();
    },
    showTerminalDialog: () => {
      void showTerminalDialog().catch((error: unknown) => {
        logger.app("diagnostics", "error", "renderer crash-loop dialog failed; quitting", {
          event: "rendererCrashLoop",
          data: { action: "dialog", error: error instanceof Error ? error.message : String(error) },
        });
        quit();
      });
    },
  });
}
