import { dialog, type BrowserWindow, type WebContents } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { IPC, type CloseBehavior, type LifecycleDialogChoice, type LifecycleDialogKind } from "@pi-desktop/shared";
import type { Logger } from "../logger";
import {
  readCloseBehavior,
  writeCloseBehavior,
} from "../window-preferences";
import type { WindowLifecycleState } from "./window";
import { createLifecycleDialogBroker } from "./lifecycle-dialog";

export type CloseBehaviorDependencies = {
  state: WindowLifecycleState;
  dataDir: string;
  getLocale: () => string;
  createTray: () => void;
  logger: Pick<Logger, "app">;
};

export function createCloseBehaviorRuntime({
  state,
  dataDir,
  getLocale,
  createTray,
  logger,
}: CloseBehaviorDependencies) {
  const lifecycleDialogs = createLifecycleDialogBroker({
    onError: (error) => {
      logger.app("lifecycle", "warn", "lifecycle dialog fallback failed", {
        data: String(error),
      });
    },
  });
  const observedWebContents = new WeakSet<WebContents>();

  const applyCloseBehavior = (next: CloseBehavior): void => {
    state.closeBehavior = next;
    writeCloseBehavior(dataDir, next);
    if (next === "tray") createTray();
  };

  const markLifecycleDialogRendererReady = (window: BrowserWindow): boolean => {
    if (window !== state.mainWindow || window.isDestroyed()) return false;
    const contents = window.webContents;
    if (contents.isDestroyed()) return false;
    if (!observedWebContents.has(contents)) {
      observedWebContents.add(contents);
      const windowId = contents.id;
      contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) lifecycleDialogs.markUnavailable(windowId);
      });
      contents.on("render-process-gone", () => lifecycleDialogs.markUnavailable(windowId));
      contents.once("destroyed", () => lifecycleDialogs.markUnavailable(windowId));
    }
    lifecycleDialogs.markReady(contents.id);
    return true;
  };

  const respondLifecycleDialog = (
    senderWindowId: number,
    requestId: unknown,
    choice: unknown,
  ): boolean => lifecycleDialogs.respond(senderWindowId, requestId, choice);

  const showLifecycleDialog = (
    window: BrowserWindow,
    kind: LifecycleDialogKind,
    fallback: () => Promise<LifecycleDialogChoice>,
  ): Promise<LifecycleDialogChoice> =>
    lifecycleDialogs.request({
      windowId: window.webContents.id,
      kind,
      send: (request) => window.webContents.send(IPC.event.lifecycleDialogRequest, request),
      dismiss: (requestId) => window.webContents.send(IPC.event.lifecycleDialogDismiss, { requestId }),
      fallback,
    });

  const showNativeCloseBehaviorDialog = async (
    window: BrowserWindow,
  ): Promise<LifecycleDialogChoice> => {
    const labels = catalogs[resolveLocale(getLocale())];
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: labels.tray.askTitle,
      message: labels.tray.askBody,
      buttons: [labels.common.cancel, labels.tray.closeToTray, labels.tray.quit],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return response === 1 ? "tray" : response === 2 ? "quit" : "cancel";
  };

  const askCloseBehavior = async (
    window: BrowserWindow,
  ): Promise<"tray" | "quit" | null> => {
    try {
      const choice = await showLifecycleDialog(
        window,
        "close-behavior",
        () => showNativeCloseBehaviorDialog(window),
      );
      return choice === "tray" || choice === "quit" ? choice : null;
    } catch (error) {
      logger.app("lifecycle", "warn", "close behavior confirmation failed; allowing quit", {
        data: String(error),
      });
      return "quit";
    }
  };

  const showNativeQuitDialog = async (
    parent: BrowserWindow | undefined,
  ): Promise<LifecycleDialogChoice> => {
    const labels = catalogs[resolveLocale(getLocale())];
    const options = {
      type: "warning" as const,
      title: labels.tray.confirmQuitTitle,
      message: labels.tray.confirmQuitBody,
      buttons: [labels.common.cancel, labels.tray.confirmQuit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 1 ? "confirm" : "cancel";
  };

  const confirmQuitDialog = async (): Promise<boolean> => {
    try {
      const parent = state.mainWindow && !state.mainWindow.isDestroyed()
        ? state.mainWindow
        : undefined;
      if (parent && (parent.isMinimized() || !parent.isVisible())) {
        parent.isMinimized() ? parent.restore() : parent.show();
        parent.focus();
      }
      const fallback = () => showNativeQuitDialog(parent);
      const choice = parent
        ? await showLifecycleDialog(parent, "quit-confirmation", fallback)
        : await fallback();
      return choice === "confirm";
    } catch (error) {
      logger.app("lifecycle", "warn", "quit confirmation failed; allowing shutdown", {
        data: String(error),
      });
      return true;
    }
  };

  return {
    applyCloseBehavior,
    askCloseBehavior,
    confirmQuitDialog,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    readCloseBehavior: () => readCloseBehavior(dataDir),
  };
}
