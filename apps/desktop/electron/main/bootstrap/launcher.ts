import { app, BrowserWindow, globalShortcut, screen } from "electron";
import { join } from "node:path";
import {
  APP_NAME,
  IPC,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  type KeybindingOverrides,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { WindowLifecycleState } from "./window";

export type LauncherState = {
  creationPromise: Promise<BrowserWindow> | null;
  pluginLauncherAccelerator: string | null;
  summonWindowAccelerator: string | null;
};

export type LauncherDependencies = {
  state: WindowLifecycleState;
  launcherState: LauncherState;
  appState: { applicationBooted: boolean };
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  restoreMainWindow: () => void;
};

export function createLauncher({
  state,
  launcherState,
  appState,
  getHost,
  logger,
  safeOpenExternal,
  restoreMainWindow,
}: LauncherDependencies) {

  const PLUGIN_LAUNCHER_WIDTH = 620;
  const PLUGIN_LAUNCHER_HEIGHT = 440;

  function pluginLauncherBounds() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    return {
      x: Math.round(x + (width - PLUGIN_LAUNCHER_WIDTH) / 2),
      y: Math.round(y + (height - PLUGIN_LAUNCHER_HEIGHT) / 2),
      width: PLUGIN_LAUNCHER_WIDTH,
      height: PLUGIN_LAUNCHER_HEIGHT,
    };
  }

  function createPluginLauncherWindow(): Promise<BrowserWindow> {
    if (launcherState.creationPromise) return launcherState.creationPromise;
    if (state.pluginLauncherWindow && !state.pluginLauncherWindow.isDestroyed()) {
      return Promise.resolve(state.pluginLauncherWindow);
    }

    const creation = (async () => {
      const window = new BrowserWindow({
        ...pluginLauncherBounds(),
        title: `${APP_NAME} Plugin Launcher`,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        autoHideMenuBar: true,
        ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: join(__dirname, "../preload/index.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
        },
      });
      state.pluginLauncherWindow = window;

      if (process.platform === "darwin") {
        // Join every Space and float above this app's own fullscreen window, but
        // never let Electron transform the process type. Without
        // `skipTransformProcessType`, `visibleOnFullScreen` runs
        // TransformProcessType(kProcessTransformToUIElementApplication) on the
        // whole process, which removes PI-Desktop from the Dock and Cmd+Tab for
        // as long as this window exists — and the launcher is prewarmed during
        // boot, so that would apply to every session (ADR 0086).
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      }
      window.webContents.setWindowOpenHandler(({ url }) => {
        void safeOpenExternal(url).catch(() => undefined);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        const devOrigin = process.env.ELECTRON_RENDERER_URL;
        if (devOrigin && url.startsWith(devOrigin)) return;
        event.preventDefault();
      });
      window.on("blur", () => {
        if (!window.isDestroyed() && !window.webContents.isDevToolsOpened()) {
          window.hide();
        }
      });
      window.on("closed", () => {
        if (state.pluginLauncherWindow === window) state.pluginLauncherWindow = null;
      });

      try {
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "plugin-launcher");
          await window.loadURL(url.toString());
        } else {
          await window.loadFile(join(__dirname, "../renderer/index.html"), {
            query: { surface: "plugin-launcher" },
          });
        }
        return window;
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    })();

    launcherState.creationPromise = creation;
    void creation.then(
      () => {
        if (launcherState.creationPromise === creation) {
          launcherState.creationPromise = null;
        }
      },
      () => {
        if (launcherState.creationPromise === creation) {
          launcherState.creationPromise = null;
        }
      },
    );
    return creation;
  }

  function prewarmPluginLauncher(): void {
    void createPluginLauncherWindow().catch((error) => {
      logger.app("diagnostics", "warn", "plugin launcher warm-up failed", {
        data: String(error),
      });
    });
  }

  async function showPluginLauncher(): Promise<void> {
    if (!appState.applicationBooted) return;
    const window = await createPluginLauncherWindow();
    if (window.isDestroyed()) return;
    window.setBounds(pluginLauncherBounds(), false);
    window.show();
    // `show()` already activates and focuses a macOS panel. Avoid a second
    // native focus/activation and window-stack move there; each adds visible
    // compositor work when another app owns the foreground window. Windows and
    // Linux retain the explicit focus and move for their frameless utility
    // window.
    if (process.platform !== "darwin") {
      window.focus();
      window.moveTop();
    }
    window.webContents.send(IPC.event.pluginLauncherShown);
  }

  async function togglePluginLauncher(): Promise<void> {
    const window = state.pluginLauncherWindow;
    if (window && !window.isDestroyed() && window.isVisible()) {
      window.hide();
      return;
    }
    await showPluginLauncher();
  }

  function applyPluginLauncherShortcut(keybindings?: KeybindingOverrides) {
    const shortcut = KEYBOARD_SHORTCUTS.find(
      (candidate) => candidate.id === "openPluginLauncher",
    );
    if (!shortcut || !app.isReady()) return;
    const platform: ShortcutPlatform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : "linux";
    const binding = resolveKeybinding(shortcut, keybindings, platform);
    const accelerator = keybindingToElectronAccelerator(binding, platform);
    state.pluginLauncherBinding = binding;

    if (process.platform === "win32" && getHost()?.isAvailable()) {
      void getHost()!
        .call("keyboard.setGlobalShortcut", { binding })
        .catch((error) =>
          logger.app("diagnostics", "warn", "Windows global shortcut mode update failed", {
            data: String(error),
          }),
        );
    }

    if (launcherState.pluginLauncherAccelerator && launcherState.pluginLauncherAccelerator !== accelerator) {
      globalShortcut.unregister(launcherState.pluginLauncherAccelerator);
      launcherState.pluginLauncherAccelerator = null;
    }

    // Windows reserves Alt+Space for the active window system menu. The
    // host-core low-level hook owns this exact binding so it still works while
    // another application is focused; do not ask Electron to register it too.
    if (process.platform === "win32" && binding === "Alt+Space") return;
    if (!accelerator || accelerator === launcherState.pluginLauncherAccelerator) return;
    const registered = globalShortcut.register(accelerator, () => {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "plugin launcher shortcut failed", {
          data: String(error),
        }),
      );
    });
    if (registered) {
      launcherState.pluginLauncherAccelerator = accelerator;
    } else {
      logger.app("diagnostics", "error", "plugin launcher shortcut unavailable", {
        data: { accelerator, platform: process.platform },
      });
    }
  }

  /**
   * Register the summon-window shortcut (D384). The default `Mod+Shift+W`
   * brings a hidden/minimized-to-tray window back into focus; this is the
   * symmetrical counterpart to `closeWindow` (`Mod+W`).
   */
  function applySummonWindowShortcut(keybindings?: KeybindingOverrides) {
    const shortcut = KEYBOARD_SHORTCUTS.find(
      (candidate) => candidate.id === "summonWindow",
    );
    if (!shortcut || !app.isReady()) return;
    const platform: ShortcutPlatform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : "linux";
    const binding = resolveKeybinding(shortcut, keybindings, platform);
    const accelerator = keybindingToElectronAccelerator(binding, platform);

    if (launcherState.summonWindowAccelerator && launcherState.summonWindowAccelerator !== accelerator) {
      globalShortcut.unregister(launcherState.summonWindowAccelerator);
      launcherState.summonWindowAccelerator = null;
    }

    if (!accelerator || accelerator === launcherState.summonWindowAccelerator) return;
    const registered = globalShortcut.register(accelerator, () => {
      restoreMainWindow();
    });
    if (registered) {
      launcherState.summonWindowAccelerator = accelerator;
    } else {
      logger.app("diagnostics", "warn", "summon window shortcut unavailable", {
        data: { accelerator, platform: process.platform },
      });
    }
  }


  return {
    pluginLauncherBounds,
    createPluginLauncherWindow,
    prewarmPluginLauncher,
    showPluginLauncher,
    togglePluginLauncher,
    applyPluginLauncherShortcut,
    applySummonWindowShortcut,
  };
}
