import {
  app, BrowserWindow, Menu, nativeImage, nativeTheme, Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  APP_MENU_COMMANDS,
  APP_NAME,
  IPC,
  isThemeColorScheme,
  traySessionTitle,
  migrateKeybindingOverrides,
  type AppMenuCommand,
  type CloseBehavior,
  type KeybindingOverrides,
  type NativeMenuAction,
} from "@pi-desktop/shared";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { installApplicationMenu } from "../application-menu";
import { createTraySessions } from "../tray-sessions";
import { createWindow, type WindowLifecycleState } from "./window";
import { windowToggleAction } from "./window-visibility";
import type { BrowserPane } from "../browser-view";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import type { HostProcess } from "../host-process";
import { syncPluginDisplayLocale } from "../plugin-display-locale";
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
  applyToggleWindowShortcut: (keybindings?: KeybindingOverrides) => void;
  broadcastPluginPanelEvent: (event: string, payload: unknown) => void;
  getHost: () => HostProcess | null;
  getRunningSessionIds: () => Iterable<string>;
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
  applyToggleWindowShortcut,
  broadcastPluginPanelEvent,
  getHost,
  getRunningSessionIds,
}: ApplicationLifecycleDependencies) {
  const traySessions = createTraySessions({
    getHost,
    getRunningSessionIds,
    isQuitting: () => state.quitting,
    onChanged: () => updateTrayMenu(),
    logger,
  });
  let trayActivationGeneration = 0;

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

  async function activateTraySession(sessionId: string | null) {
    const generation = ++trayActivationGeneration;
    await ensureWindow();
    const window = state.mainWindow;
    if (!window || window.isDestroyed() || !(await waitForMenuRenderer(window))) return;
    if (generation !== trayActivationGeneration) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (sessionId) await traySessions.refresh();
    if (
      generation !== trayActivationGeneration ||
      window !== state.mainWindow ||
      window.isDestroyed()
    ) return;
    if (sessionId && !traySessions.canActivate(sessionId)) return;
    sendToRenderer(IPC.event.traySessionActivated, { sessionId });
  }

  function dispatchTrayActivation(sessionId: string | null) {
    void activateTraySession(sessionId).catch((error) => {
      logger.app("diagnostics", "error", "tray session activation failed", {
        data: String(error),
      });
    });
  }

  /**
   * One press of the merged window shortcut (D438): hide the window the user is
   * looking at, otherwise bring it back. Hiding is `Window.hide()` and never
   * the close path, so it raises no close-behaviour prompt, destroys no window,
   * and quits nothing — the tray (or the same key again) is the way back.
   */
  function toggleMainWindow() {
    const window = state.mainWindow;
    if (window && !window.isDestroyed() && windowToggleAction(window) === "hide") {
      window.hide();
      return;
    }
    restoreMainWindow();
  }

  function updateTrayMenu(locale = appearanceState.updaterLocale || app.getLocale()) {
    if (!state.tray) return;
    const catalog = catalogs[resolveLocale(locale)];
    const labels = catalog.tray;
    const template: MenuItemConstructorOptions[] = [
      { label: labels.open, click: restoreMainWindow },
    ];
    for (const group of traySessions.getGroups()) {
      template.push({ type: "separator" }, { label: labels[group.kind], enabled: false });
      for (const session of group.sessions) {
        const title = traySessionTitle(session.title, catalog.chat.untitledTask);
        template.push({
          label: process.platform === "darwin" ? title : title.replace(/&/g, "&&"),
          click: () => dispatchTrayActivation(session.id),
        });
      }
      if (group.hasMore) {
        template.push({ label: labels.viewMore, click: () => dispatchTrayActivation(null) });
      }
    }
    state.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...template,
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
    // macOS single-click opens its attached menu without focusing/reading a conversation.
    // mouse-enter/move/leave replace the native NSStatusItem with a custom view,
    // which hides the menu-bar extra. Keep hover retry on Windows/Linux only.
    if (process.platform !== "darwin") {
      state.tray.on("click", restoreMainWindow);
      state.tray.on("mouse-enter", () => { void traySessions.refresh(); });
      state.tray.on("right-click", () => { void traySessions.refresh(); });
    }
    state.tray.on("double-click", restoreMainWindow);
    updateTrayMenu();
    void traySessions.refresh();
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
    if (action === "restoreMainWindow" || action === "toggleMainWindow") {
      if (action === "restoreMainWindow") restoreMainWindow();
      else toggleMainWindow();
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
    if (isThemeColorScheme(preference)) {
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

  /**
   * Apply only the `AppSettings.theme` preference to the host's appearance
   * state. Reused by `applyApplicationMenuSettings` so the full-settings path
   * and the narrow plugin `app.setTheme` path (ADR 0260) agree.
   *
   * Deliberately narrower than `applyApplicationMenuSettings`: theme changes
   * never touch the locale, keybindings, or developer-mode menu state, so a
   * caller that only knows the theme cannot reset those fields by passing a
   * partial settings object.
   */
  function applyAppThemePreference(preference: unknown) {
    appearanceState.appThemePreference = isThemeColorScheme(preference)
      ? preference
      : typeof preference === "string" && preference.startsWith("plugin:")
        ? preference
        : "system";
    applyNativeThemeSource({ theme: preference });
    if (isThemeColorScheme(preference)) {
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
      // Plugin labels are resolved in the host (a plugin ships them per
      // locale), so the change is pushed there before the surfaces re-read.
      // `pluginChanged` is also what makes the Extensions page re-list, so a
      // language switch localizes the rows without a restart (ADR 0160).
      void syncPluginDisplayLocale(getHost(), locale)
        .then(() => sendToRenderer(IPC.event.pluginChanged, { reason: "locale" }))
        // Notifying is best-effort: a window that is already gone must not turn
        // a language change into an unhandled rejection.
        .catch(() => {});
    }
    applyAppThemePreference(settings?.theme);
    // Persisted keybindings can still carry the retired window ids (D438); the
    // main process is the only reader when the window never opens, so it folds
    // them itself instead of relying on a renderer write-back.
    const keybindings = migrateKeybindingOverrides(
      settings?.keybindings && typeof settings.keybindings === "object"
        ? (settings.keybindings as KeybindingOverrides)
        : undefined,
    );
    applyPluginLauncherShortcut(keybindings);
    applyToggleWindowShortcut(keybindings);
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

  /**
   * Push the current appearance to every open plugin panel and every loaded
   * plugin process, when it changed. Plugin-owned UI localizes from this
   * payload (ADR 0280).
   */
  function broadcastAppearance(): void {
    const appearance = resolveAppearance();
    const signature = JSON.stringify(appearance);
    if (signature === appearanceState.broadcastAppearanceSignature) return;
    appearanceState.broadcastAppearanceSignature = signature;
    broadcastPluginPanelEvent("appearance:changed", appearance);
    plugins.broadcastEvent("appearance:changed", [appearance]);
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
    traySessions,
    applyDevelopmentBranding,
    hasVisibleWindow,
    restoreMainWindow,
    toggleMainWindow,
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
    applyAppThemePreference,
    applyApplicationMenuSettings,
    resolveAppearance,
    broadcastAppearance,
    flushPendingApplicationMenuCommands,
  };
}
