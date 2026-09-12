import { dialog, type BrowserWindow } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { CloseBehavior } from "@pi-desktop/shared";
import {
  readCloseBehavior,
  writeCloseBehavior,
} from "../window-preferences";
import type { WindowLifecycleState } from "./window";

export type CloseBehaviorDependencies = {
  state: WindowLifecycleState;
  dataDir: string;
  getLocale: () => string;
  createTray: () => void;
};

export function createCloseBehaviorRuntime({
  state,
  dataDir,
  getLocale,
  createTray,
}: CloseBehaviorDependencies) {
  const applyCloseBehavior = (next: CloseBehavior): void => {
    state.closeBehavior = next;
    writeCloseBehavior(dataDir, next);
    if (next === "tray") createTray();
  };

  const askCloseBehavior = async (
    window: BrowserWindow,
  ): Promise<"tray" | "quit" | null> => {
    const labels = catalogs[resolveLocale(getLocale())];
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: labels.tray.askTitle,
      message: labels.tray.askTitle,
      detail: labels.tray.askBody,
      buttons: [labels.common.cancel, labels.tray.closeToTray, labels.tray.quit],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return response === 1 ? "tray" : response === 2 ? "quit" : null;
  };

  const confirmQuitDialog = async (): Promise<boolean> => {
    const labels = catalogs[resolveLocale(getLocale())];
    const parent =
      state.mainWindow && !state.mainWindow.isDestroyed()
        ? state.mainWindow
        : undefined;
    const options = {
      type: "warning" as const,
      title: labels.tray.confirmQuitTitle,
      message: labels.tray.confirmQuitTitle,
      detail: labels.tray.confirmQuitBody,
      buttons: [labels.common.cancel, labels.tray.confirmQuit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 1;
  };

  return {
    applyCloseBehavior,
    askCloseBehavior,
    confirmQuitDialog,
    readCloseBehavior: () => readCloseBehavior(dataDir),
  };
}
