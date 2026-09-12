import { BrowserWindow } from "electron";
import {
  ErrorCodes,
  IPC,
  NATIVE_MENU_ACTIONS,
  WINDOW_CONTROL_ACTIONS,
  type NativeMenuAction,
  type WindowControlAction,
} from "@pi-desktop/shared";
import {
  emptyWorkPanelReservationState,
  parseWorkPanelChatWidth,
  parseWorkPanelReservationWidth,
  type WorkPanelReservationState,
} from "../work-panel-window";
import type { IpcRegistrar } from "./types";

export type WindowIpcDependencies = {
  registrar: IpcRegistrar;
  getMainWindow: () => BrowserWindow | null;
  getWorkPanelReservationWidth: () => number;
  setWorkPanelReservationWidth: (width: number) => void;
  setWorkPanelReservation: (state: WorkPanelReservationState) => void;
  getWorkPanelChatWidthSetter: () => ((width: number) => number) | null;
  applyCloseBehavior: (behavior: "tray" | "quit") => void;
  getCloseBehavior: () => "ask" | "tray" | "quit";
  markMenuRendererReady: (window: BrowserWindow) => boolean;
  executeNativeMenuAction: (action: NativeMenuAction) => unknown;
};

/** Register renderer-drawn window chrome and work-panel geometry channels. */
export function registerWindowIpc({
  registrar,
  getMainWindow,
  getWorkPanelReservationWidth,
  setWorkPanelReservationWidth,
  setWorkPanelReservation,
  getWorkPanelChatWidthSetter,
  applyCloseBehavior,
  getCloseBehavior,
  markMenuRendererReady,
  executeNativeMenuAction,
}: WindowIpcDependencies): void {
  const { handle, handleWithEvent } = registrar;

  handle(IPC.invoke.windowSetWorkPanelReservation, async (input: unknown = {}) => {
    const requested = parseWorkPanelReservationWidth(input);
    if (requested === null) {
      throw Object.assign(new Error("invalid work panel reservation width"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!getMainWindow() || getMainWindow()?.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    setWorkPanelReservationWidth(0);
    setWorkPanelReservation(emptyWorkPanelReservationState());
    return { requested: 0, reserved: 0 };
  });

  handle(IPC.invoke.windowSetWorkPanelChatWidth, async (input: unknown = {}) => {
    const requested = parseWorkPanelChatWidth(input);
    if (requested === null) {
      throw Object.assign(new Error("invalid work panel chat width"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!getMainWindow() || getMainWindow()?.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    const setter = getWorkPanelChatWidthSetter();
    if (!setter || getWorkPanelReservationWidth() <= 0) {
      throw new Error("work panel unavailable");
    }
    return { requested, applied: setter(requested) };
  });

  handle(IPC.invoke.windowSetBackgroundColor, async (input: unknown = {}) => {
    const theme = (input as { theme?: unknown })?.theme;
    if (theme !== "light" && theme !== "dark") {
      throw Object.assign(new Error("invalid window background theme"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (process.platform === "darwin") return { applied: false, theme };
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    mainWindow.setBackgroundColor(theme === "light" ? "#ffffff" : "#181818");
    return { applied: true, theme };
  });

  handle(IPC.invoke.windowControl, async (input: { action?: string } = {}) => {
    if (
      !input.action ||
      !WINDOW_CONTROL_ACTIONS.includes(input.action as WindowControlAction)
    ) {
      throw new Error("unsupported window control action");
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false };
    switch (input.action as WindowControlAction) {
      case "getState":
        break;
      case "minimize":
        mainWindow.minimize();
        break;
      case "toggleMaximize":
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        break;
      case "close":
        mainWindow.close();
        break;
    }
    return {
      maximized: !mainWindow.isDestroyed() && mainWindow.isMaximized(),
    };
  });

  handle(IPC.invoke.closeBehaviorGet, async () => ({
    behavior: getCloseBehavior(),
    supported: process.platform !== "darwin",
  }));

  handle(IPC.invoke.closeBehaviorSet, async (input: unknown = {}) => {
    if (process.platform === "darwin") {
      throw Object.assign(new Error("close behavior is not configurable"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const behavior = (input as { behavior?: unknown })?.behavior;
    if (behavior !== "tray" && behavior !== "quit") {
      throw Object.assign(new Error("invalid close behavior"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    applyCloseBehavior(behavior);
    return { behavior };
  });

  handleWithEvent(IPC.invoke.menuRendererReady, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = getMainWindow();
    if (!window || window !== mainWindow || !markMenuRendererReady(window)) {
      throw new Error("menu renderer is not attached to the main window");
    }
    return { ready: true };
  });

  handle(IPC.invoke.nativeMenuAction, async (input: { action?: string } = {}) => {
    if (
      !input.action ||
      !NATIVE_MENU_ACTIONS.includes(input.action as NativeMenuAction)
    ) {
      throw new Error("unsupported native menu action");
    }
    return executeNativeMenuAction(input.action as NativeMenuAction);
  });
}
