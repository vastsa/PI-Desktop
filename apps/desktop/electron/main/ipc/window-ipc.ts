import { BrowserWindow } from "electron";
import { isWindowBackgroundColor, MAX_WINDOW_CORNER_RADIUS } from "@pi-desktop/plugin-sdk";
import {
  builtinWindowBackground,
  ErrorCodes,
  IPC,
  isThemeColorScheme,
  NATIVE_MENU_ACTIONS,
  WINDOW_CONTROL_ACTIONS,
  parseTraySessionPreferences,
  type NativeMenuAction,
  type WindowControlAction,
  type LifecycleDialogChoice,
  type TraySessionPreferences,
} from "@pi-desktop/shared";
import {
  emptyWorkPanelReservationState,
  parseWorkPanelChatWidth,
  parseWorkPanelReservationWidth,
  type WorkPanelReservationState,
} from "../work-panel-window";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
} from "../window-shape";
import { applyWindowCornerRadius, usesWindows11NativeCorners } from "../window-native-corners";
import { applyMainWindowBackground } from "../window-background";
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
  markLifecycleDialogRendererReady: (window: BrowserWindow) => boolean;
  respondLifecycleDialog: (senderWindowId: number, requestId: unknown, choice: LifecycleDialogChoice) => boolean;
  markMenuRendererReady: (window: BrowserWindow) => boolean;
  executeNativeMenuAction: (action: NativeMenuAction) => unknown;
  setTraySessionPreferences: (preferences: TraySessionPreferences) => Promise<void>;
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
  markLifecycleDialogRendererReady,
  respondLifecycleDialog,
  executeNativeMenuAction,
  setTraySessionPreferences,
}: WindowIpcDependencies): void {
  const { handle, handleWithEvent } = registrar;
  handleWithEvent(IPC.invoke.traySetSessionPreferences, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    const preferences = parseTraySessionPreferences(input);
    if (!preferences) {
      throw Object.assign(new Error("invalid tray session preferences"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    await setTraySessionPreferences(preferences);
    return { ok: true };
  });

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

  handleWithEvent(IPC.invoke.windowSetBackgroundColor, async (event, input: unknown = {}) => {
    registrar.assertMainWindowSender(event);
    const theme = (input as { theme?: unknown })?.theme;
    if (!isThemeColorScheme(theme)) {
      throw Object.assign(new Error("invalid window background theme"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // A plugin theme may name its own background; anything else, including an
    // omitted value, falls back to the host palette for the resolved theme. The
    // renderer recomputes this from the persisted preference and the live theme
    // catalog on every theme, plugin, and OS-appearance change, so switching
    // away, disabling, or uninstalling the provider restores the default by
    // derivation rather than by remembering what to undo.
    const requested = (input as { color?: unknown })?.color;
    if (requested !== undefined && requested !== null && !isWindowBackgroundColor(requested)) {
      throw Object.assign(new Error("invalid window background color"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const requestedRadius = (input as { cornerRadius?: unknown })?.cornerRadius;
    if (
      requestedRadius !== undefined && requestedRadius !== null &&
      (typeof requestedRadius !== "number" || !Number.isInteger(requestedRadius) ||
        requestedRadius < 0 || requestedRadius > MAX_WINDOW_CORNER_RADIUS)
    ) {
      throw Object.assign(new Error("invalid window corner radius"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (process.platform === "darwin") return { applied: false, theme };
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    const color = isWindowBackgroundColor(requested)
      ? requested
      : builtinWindowBackground(theme);
    const windows11NativeCorners = usesWindows11NativeCorners(
      process.platform,
      process.getSystemVersion(),
    );
    applyMainWindowBackground(
      mainWindow,
      process.platform,
      color,
      windows11NativeCorners,
      builtinWindowBackground(theme),
    );
    const cornerRadius = process.platform === "win32"
      ? await applyWindowCornerRadius(
          mainWindow,
          typeof requestedRadius === "number" ? requestedRadius : DEFAULT_WINDOW_CORNER_RADIUS,
        )
      : null;
    return { applied: true, theme, color, cornerRadius };
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
      // `toggleMaximize` and the rest run through the shared native-menu
      // action so the maximize/fullscreen interlock (issue #1655) has one
      // implementation: calling `mainWindow.maximize()` directly would skip
      // the fullscreen-first rule and leave both flags set.
      case "toggleMaximize":
      case "close":
        return executeNativeMenuAction(input.action as NativeMenuAction);
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

  handleWithEvent(IPC.invoke.lifecycleDialogReady, async (event) => {
    registrar.assertMainWindowSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !markLifecycleDialogRendererReady(window)) {
      throw Object.assign(new Error("lifecycle dialog renderer is not ready"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    return { ready: true };
  });

  handleWithEvent(IPC.invoke.lifecycleDialogRespond, async (event, input: unknown = {}) => {
    registrar.assertMainWindowSender(event);
    const value = input && typeof input === "object"
      ? input as Record<string, unknown>
      : null;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      !value.requestId ||
      value.requestId.length > 64 ||
      (value.choice !== "cancel" && value.choice !== "confirm" && value.choice !== "tray" && value.choice !== "quit")
    ) {
      throw Object.assign(new Error("invalid lifecycle dialog response"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return {
      accepted: respondLifecycleDialog(event.sender.id, value.requestId, value.choice as LifecycleDialogChoice),
    };
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
