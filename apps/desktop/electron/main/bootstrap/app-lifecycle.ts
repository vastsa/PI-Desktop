import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Tray } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  APP_MENU_COMMANDS,
  APP_NAME,
  IPC,
  type AppMenuCommand,
  type CloseBehavior,
  type KeybindingOverrides,
  type NativeMenuAction,
} from "@pi-desktop/shared";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { installApplicationMenu } from "../application-menu";
import { createWindow, type WindowLifecycleState } from "./window";
import type { BrowserPane } from "../browser-view";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import type { PluginAppearance } from "../../shared/plugin-panel-chrome";

export type ApplicationLifecycleState = {
  windowCreationPromise: Promise<void> | null;
  applicationBooted: boolean;
  pendingApplicationMenuCommands: AppMenuCommand[];
  appliedMenuSettings: string | null;
};

export type ApplicationAppearanceState = {
  updaterLocale: string;
  pluginPanelTheme: "light" | "dark";
  appThemePreference: string;
  broadcastAppearanceSignature: string;
};

export type ApplicationLifecycleDependencies = {
  state: WindowLifecycleState;
  appState: ApplicationLifecycleState;
  appearanceState: ApplicationAppearanceState;
  dataDir: string;
  isDevelopmentBuild: boolean;
  windowsAllowedToClose: WeakSet<BrowserWindow>;
  windowMinWidth: number;
  windowMinHeight: number;
  windowBoundsSettleMs: number;
  workPanelNativeResizeSettleMs: number;
  applyWorkPanelReservation: () => any;
  markWorkPanelChatResizeActive: () => void;
  workPanelMinimumWindowWidth: () => number;
  observedWorkPanelBaseBounds: (...args: any[]) => any;
  classifyDisplayTransition: (...args: any[]) => any;
  sendToRenderer: (channel: string, payload: unknown) => void;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  showPluginLauncher: () => Promise<void>;
  askCloseBehavior: (window: BrowserWindow) => Promise<CloseBehavior | null>;
  applyCloseBehavior: (behavior: CloseBehavior) => void;
  browserPane: BrowserPane;
  pluginViews: PluginViewHost;
  plugins: PluginRuntime;
  logger: Pick<Logger, "app">;
  refreshReleaseNotes: () => void;
  applyPluginLauncherShortcut: (keybindings?: KeybindingOverrides) => void;
  applySummonWindowShortcut: (keybindings?: KeybindingOverrides) => void;
  broadcastPluginPanelEvent: (event: string, payload: unknown) => void;
};

export function createApplicationLifecycle({
  state,
  appState,
  appearanceState,
  dataDir,
  isDevelopmentBuild,
  windowsAllowedToClose,
  windowMinWidth,
  windowMinHeight,
  windowBoundsSettleMs,
  workPanelNativeResizeSettleMs,
  applyWorkPanelReservation,
  markWorkPanelChatResizeActive,
  workPanelMinimumWindowWidth,
  observedWorkPanelBaseBounds,
  classifyDisplayTransition,
  sendToRenderer,
  safeOpenExternal,
  showPluginLauncher,
  askCloseBehavior,
  applyCloseBehavior,
  browserPane,
  pluginViews,
  plugins,
  logger,
  refreshReleaseNotes,
  applyPluginLauncherShortcut,
  applySummonWindowShortcut,
  broadcastPluginPanelEvent,
}: ApplicationLifecycleDependencies) {

  function applyDevelopmentBranding() {
    if (process.platform !== "darwin" || !isDevelopmentBuild || !app.dock) return;

    const iconPath = join(app.getAppPath(), "build", "icon_1024.png");
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      logger.app("lifecycle", "warn", "development dock icon missing", {
        data: { iconPath },
      });
      return;
    }

    app.dock.setIcon(icon);
  }

  function trayIconPath() {
    const resourceRoot = app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), "build");
    const candidates =
      process.platform === "darwin"
        ? [
          join(resourceRoot, "tray-icon-mac.png"),
          join(resourceRoot, app.isPackaged ? "tray-icon.png" : "icon.png"),
          ]
        : [join(resourceRoot, app.isPackaged ? "tray-icon.png" : "icon.png")];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  function hasVisibleWindow(): boolean {
    return BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
  }

  function restoreMainWindow() {
    void ensureWindow()
      .then(() => {
        const window = state.mainWindow;
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      })
      .catch((error) => {
      logger.app("diagnostics", "error", "tray restore failed", {
          data: String(error),
        });
      });
  }

  function updateTrayMenu(locale = app.getLocale()) {
    if (!state.tray) return;
  const labels = catalogs[resolveLocale(locale)].tray;
    state.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels.open, click: restoreMainWindow },
        { type: "separator" },
        { label: labels.quit, click: () => app.quit() },
      ]),
    );
  }

  function createTray() {
    if (state.tray) return;
    const iconPath = trayIconPath();
    if (!iconPath) {
    logger.app("lifecycle", "warn", "tray icon missing", {
        data: { packaged: app.isPackaged, resourcesPath: process.resourcesPath },
      });
      return;
    }

    const source = nativeImage.createFromPath(iconPath);
    if (source.isEmpty()) {
    logger.app("lifecycle", "warn", "tray icon could not be loaded", {
        data: { iconPath },
      });
      return;
    }
    const icon = source.resize({
      width: process.platform === "darwin" ? 18 : 16,
      height: process.platform === "darwin" ? 18 : 16,
    });
    if (process.platform === "darwin") icon.setTemplateImage(true);

    state.tray = new Tray(icon);
    state.tray.setToolTip(APP_NAME);
    state.tray.on("click", restoreMainWindow);
    state.tray.on("double-click", restoreMainWindow);
    updateTrayMenu();
  }



  function resetMenuRendererReady(window: BrowserWindow) {
    state.menuRendererReadyGate?.resolve();
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((ready) => {
      resolve = ready;
    });
    state.menuRendererReadyGate = {
      window,
      ready: false,
      promise,
      resolve,
    };
  }

  function markMenuRendererReady(window: BrowserWindow): boolean {
    const gate = state.menuRendererReadyGate;
    if (gate?.window !== window || window.isDestroyed()) return false;
    gate.ready = true;
    gate.resolve();
    return true;
  }

  async function waitForMenuRenderer(window: BrowserWindow): Promise<boolean> {
    const gate = state.menuRendererReadyGate;
    if (gate?.window !== window) return false;
    await gate.promise;
    return (
      state.menuRendererReadyGate === gate &&
      gate.ready &&
      state.mainWindow === window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed()
    );
  }

  function createWindowForLifecycle(): Promise<void> {
    return createWindow({
      state: state,
      dataDir,
      windowMinWidth,
      windowMinHeight,
      windowBoundsSettleMs,
      workPanelNativeResizeSettleMs,
      windowsAllowedToClose,
      applyWorkPanelReservation,
      markWorkPanelChatResizeActive,
      workPanelMinimumWindowWidth,
      observedWorkPanelBaseBounds,
      classifyDisplayTransition,
      resetMenuRendererReady,
      markMenuRendererReady,
      sendToRenderer,
      safeOpenExternal,
      showPluginLauncher,
      askCloseBehavior,
      applyCloseBehavior,
      createTray,
      browserPane,
      pluginViews,
      plugins,
      logger,
    });
  }

  async function ensureWindow(): Promise<boolean> {
    if (appState.windowCreationPromise) {
      await appState.windowCreationPromise;
      return true;
    }
    if (state.mainWindow && !state.mainWindow.isDestroyed()) return false;

    const creation = createWindowForLifecycle();
    appState.windowCreationPromise = creation;
    try {
      await creation;
      return true;
    } finally {
      if (appState.windowCreationPromise === creation) appState.windowCreationPromise = null;
    }
  }

  async function deliverApplicationMenuCommand(command: AppMenuCommand) {
    await ensureWindow();
    const window = state.mainWindow;
    if (!window || window.isDestroyed()) return;
    if (!(await waitForMenuRenderer(window))) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    sendToRenderer(IPC.event.menuCommand, { command });
  }

  function dispatchApplicationMenuCommand(command: AppMenuCommand) {
    if (!APP_MENU_COMMANDS.includes(command)) return;
    if (!appState.applicationBooted) {
      appState.pendingApplicationMenuCommands.push(command);
      return;
    }
    void deliverApplicationMenuCommand(command).catch((error) => {
      logger.app("diagnostics", "error", "application menu command failed", {
        data: String(error),
      });
    });
  }

  function executeNativeMenuAction(
    action: NativeMenuAction,
    target: BrowserWindow | null = state.mainWindow,
  ) {
    if (action === "restoreMainWindow") {
      restoreMainWindow();
      const window = state.mainWindow;
      return {
        maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
        fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
      };
    }
    if (!target || target.isDestroyed()) {
      return { maximized: false, fullScreen: false };
    }

    const contents = target.webContents;
    switch (action) {
      case "undo":
        contents.undo();
        break;
      case "redo":
        contents.redo();
        break;
      case "cut":
        contents.cut();
        break;
      case "copy":
        contents.copy();
        break;
      case "paste":
        contents.paste();
        break;
      case "selectAll":
        contents.selectAll();
        break;
      case "reload":
        contents.reload();
        break;
      case "zoomIn":
        contents.setZoomFactor(Math.min(3, contents.getZoomFactor() * 1.1));
        break;
      case "zoomOut":
        contents.setZoomFactor(Math.max(0.5, contents.getZoomFactor() / 1.1));
        break;
      case "resetZoom":
        contents.setZoomFactor(1);
        break;
      case "toggleFullScreen":
        target.setFullScreen(!target.isFullScreen());
        break;
      case "minimize":
        target.minimize();
        break;
      case "toggleMaximize":
        if (target.isMaximized()) target.unmaximize();
        else target.maximize();
        break;
      case "close":
        target.close();
        break;
    }

    return {
      maximized: !target.isDestroyed() && target.isMaximized(),
      fullScreen: !target.isDestroyed() && target.isFullScreen(),
    };
  }

  function dispatchNativeMenuAction(action: NativeMenuAction) {
    void executeNativeMenuAction(action);
  }


  function applyDeveloperMode(settings?: { developerMode?: unknown } | null) {
    const next = settings?.developerMode === true;
    if (next === state.developerMode) return;
    state.developerMode = next;
    // Leaving developer mode should not strand an open console.
    if (!next && state.mainWindow && !state.mainWindow.isDestroyed()) {
      if (state.mainWindow.webContents.isDevToolsOpened()) {
        state.mainWindow.webContents.closeDevTools();
      }
    }
  }

  /**
   * Drive Chromium and macOS native chrome (menus, vibrancy) from the same
   * theme preference the renderer paints. `system` keeps following the OS;
   * an explicit or plugin base locks the native appearance so a dark dock
   * cannot sit on a light Liquid Glass plate (D348). Missing `plugin:` themes
   * fall back to `system`, matching the renderer.
   */

  function applyNativeThemeSource(settings?: { theme?: unknown } | null) {
    const preference = settings?.theme;
    let next: "system" | "light" | "dark" = "system";
    if (preference === "light" || preference === "dark") {
      next = preference;
    } else if (typeof preference === "string" && preference.startsWith("plugin:")) {
      const pluginTheme = plugins.getThemes().find((theme) => theme.id === preference);
      if (pluginTheme?.base === "light" || pluginTheme?.base === "dark") {
        next = pluginTheme.base;
      }
    }
    if (nativeTheme.themeSource === next) return;
    nativeTheme.themeSource = next;
    if (process.platform === "darwin" && state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.setVibrancy("sidebar");
    }
  }

  /** Keep native labels and accelerators aligned with persisted app settings. */
  function applyApplicationMenuSettings(settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) {
    const locale =
      typeof settings?.language === "string" &&
      settings.language &&
      settings.language !== "auto"
        ? settings.language
        : app.getLocale();
    if (locale !== appearanceState.updaterLocale) {
      appearanceState.updaterLocale = locale;
      refreshReleaseNotes();
    }
    const preference = settings?.theme;
    appearanceState.appThemePreference =
      preference === "light" || preference === "dark"
        ? preference
        : typeof preference === "string" && preference.startsWith("plugin:")
          ? preference
          : "system";
    applyNativeThemeSource(settings);
    if (preference === "light" || preference === "dark") {
      appearanceState.pluginPanelTheme = preference;
    } else if (typeof preference === "string" && preference.startsWith("plugin:")) {
      const pluginTheme = plugins.getThemes().find((theme) => theme.id === preference);
      appearanceState.pluginPanelTheme =
        pluginTheme?.base ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
    } else {
      appearanceState.pluginPanelTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    // Panels mirror the app's palette/language live; push any change now.
    broadcastAppearance();
    const keybindings =
      settings?.keybindings && typeof settings.keybindings === "object"
        ? (settings.keybindings as KeybindingOverrides)
        : undefined;
    applyPluginLauncherShortcut(keybindings);
    applySummonWindowShortcut(keybindings);
    const devMode = settings?.developerMode === true;
    const signature = JSON.stringify({ locale, keybindings, devMode });
    if (appState.appliedMenuSettings === signature) return;
    appState.appliedMenuSettings = signature;
    installApplicationMenu({
      locale,
      keybindings,
      developerMode: devMode,
      dispatch: dispatchApplicationMenuCommand,
      dispatchNative: dispatchNativeMenuAction,
    });
    updateTrayMenu(locale);
  }

  /**
   * The appearance the host is currently showing, served to plugin panels and
   * plugin processes through `app.getAppearance`.
   *
   * The resolved `base` mirrors the window-chrome logic in `applyApplicationMenuSettings`:
   * an explicit light/dark preference wins, a `plugin:` preference resolves through
   * the contributed theme registry (falling back to `system` when the theme is gone),
   * and anything else follows the OS.
   */
  function resolveAppearance(): PluginAppearance {
    let base: PluginAppearance["base"] = appearanceState.pluginPanelTheme;
    let pluginTheme: PluginAppearance["pluginTheme"] = null;
    if (appearanceState.appThemePreference.startsWith("plugin:")) {
      const theme = plugins.getThemes().find((item) => item.id === appearanceState.appThemePreference);
      if (theme) {
        base = theme.base;
        pluginTheme = { id: theme.id, base: theme.base, css: theme.css };
      } else {
        base = "system";
      }
    }
    return { theme: appearanceState.appThemePreference, base, locale: appearanceState.updaterLocale, pluginTheme };
  }

  /** Push the current appearance to every open plugin panel, when it changed. */
  function broadcastAppearance(): void {
    const appearance = resolveAppearance();
    const signature = JSON.stringify(appearance);
    if (signature === appearanceState.broadcastAppearanceSignature) return;
    appearanceState.broadcastAppearanceSignature = signature;
    broadcastPluginPanelEvent("appearance:changed", appearance);
  }

  function flushPendingApplicationMenuCommands() {
    const commands = appState.pendingApplicationMenuCommands.splice(0);
    void (async () => {
      for (const command of commands) {
        await deliverApplicationMenuCommand(command);
      }
    })().catch((error) => {
      logger.app("diagnostics", "error", "queued application menu command failed", {
        data: String(error),
      });
    });
  }

  return {
    applyDevelopmentBranding,
    hasVisibleWindow,
    restoreMainWindow,
    updateTrayMenu,
    createTray,
    resetMenuRendererReady,
    markMenuRendererReady,
    waitForMenuRenderer,
    createWindowForLifecycle,
    ensureWindow,
    deliverApplicationMenuCommand,
    dispatchApplicationMenuCommand,
    executeNativeMenuAction,
    dispatchNativeMenuAction,
    applyDeveloperMode,
    applyNativeThemeSource,
    applyApplicationMenuSettings,
    resolveAppearance,
    broadcastAppearance,
    flushPendingApplicationMenuCommands,
  };
}
