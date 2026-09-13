import { app, BrowserWindow, Menu } from "electron";
import {
  APP_NAME,
  APP_VERSION,
  ErrorCodes,
  IPC,
  type AppMenuCommand,
  type CloseBehavior,
  type KeybindingOverrides,
  type NativeMenuAction,
} from "@pi-desktop/shared";
import { installApplicationMenu } from "../application-menu";
import { applyNetworkProxyFromAppSettings } from "../network-proxy";
import { readCloseBehavior } from "../window-preferences";
import { createAgentHostBridge, type AgentHostBridge } from "../agent-host-bridge";
import {
  createMcpControlController,
  McpControlServer,
  mcpControlRendererEvent,
  type McpControlController,
} from "../mcp-control";
import type { ModelsDevCatalog } from "../models-dev-catalog";
import type { AppUpdaterController } from "../updater";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import { runSessionListProbe } from "../session-list-probe";

type IpcInvoker = (
  channel: string,
  args?: readonly unknown[],
) => Promise<unknown>;

export type StartupState = {
  applicationBooted: boolean;
  closeBehavior: CloseBehavior;
  agentHostBridge: AgentHostBridge | null;
  desktopControl: McpControlController | null;
  mcpControl: McpControlServer | null;
};

export type StartupDependencies = {
  hasSingleInstanceLock: boolean;
  state: StartupState;
  dataDir: string;
  logger: Logger;
  updater: AppUpdaterController;
  modelsDevCatalog: ModelsDevCatalog;
  plugins: PluginRuntime;
  activeTurns: Map<string, string>;
  turnFinalizations: Map<string, Promise<void>>;
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  applyDevelopmentBranding: () => void;
  createTray: () => void;
  dispatchApplicationMenuCommand: (command: AppMenuCommand) => void;
  dispatchNativeMenuAction: (action: NativeMenuAction) => void;
  prewarmPluginLauncher: () => void;
  registerIpc: () => IpcInvoker;
  bootBackends: () => Promise<void>;
  planUiProbe: { install: () => void };
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyPluginLauncherShortcut: (keybindings?: KeybindingOverrides) => void;
  applySummonWindowShortcut: (keybindings?: KeybindingOverrides) => void;
  ensureWindow: () => Promise<boolean>;
  bootHostStatus: (bootError: unknown) => unknown;
  flushPendingApplicationMenuCommands: () => void;
  getSidecar?: () => unknown;
};

/**
 * Register the Electron-ready boot sequence. The sequence remains deliberately
 * ordered here, while its mutable process resources are supplied by the main
 * composition root through `StartupState` and dependency callbacks.
 */
export function registerApplicationStartup(deps: StartupDependencies): void {
  void app.whenReady().then(async () => {
    const {
      hasSingleInstanceLock,
      state,
      dataDir,
      logger,
      updater,
      modelsDevCatalog,
      plugins,
      activeTurns,
      turnFinalizations,
      getHost,
      getMainWindow,
      sendToRenderer,
      applyDevelopmentBranding,
      createTray,
      dispatchApplicationMenuCommand,
      dispatchNativeMenuAction,
      prewarmPluginLauncher,
      registerIpc,
      bootBackends,
      planUiProbe,
      applyApplicationMenuSettings,
      applyDeveloperMode,
      applyPluginLauncherShortcut,
      applySummonWindowShortcut,
      ensureWindow,
      bootHostStatus,
      flushPendingApplicationMenuCommands,
    } = deps;

    // A launch that lost the single-instance lock is already quitting. Never
    // create a window, a tray, or a child process on top of the running app.
    if (!hasSingleInstanceLock) return;
    applyDevelopmentBranding();
    // Load the close-behavior preference before the first window exists: the
    // close handler reads `closeBehavior` synchronously, and a window created
    // while it still held the "ask" default would prompt a user who already
    // chose.
    const storedBehavior = readCloseBehavior(dataDir);
    if (storedBehavior) state.closeBehavior = storedBehavior;
    createTray();
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: APP_VERSION,
      version: APP_VERSION,
    });
    installApplicationMenu({
      locale: app.getLocale(),
      dispatch: dispatchApplicationMenuCommand,
      dispatchNative: dispatchNativeMenuAction,
    });
    // Start the retained launcher as soon as Electron is ready. It can load in
    // parallel with host/plugin boot, so the first post-boot Option+Space does
    // not race the renderer allocation just because backend startup was slow.
    prewarmPluginLauncher();
    const invokeIpc = registerIpc();
    state.agentHostBridge = createAgentHostBridge({
      invoke: invokeIpc,
      channels: IPC.invoke,
      getHost,
      isSessionBusy: (sessionId) =>
        activeTurns.has(sessionId) || turnFinalizations.has(sessionId),
      onQueueChange: (event) => sendToRenderer(IPC.event.agentQueueChanged, event),
      log: (level, message, data) => logger.app("runtime", level, message, { data }),
    });
    const control = createMcpControlController({
      invoke: invokeIpc,
      channels: IPC.invoke,
      onOperationComplete: async (operation, result, args, source) => {
        const event = mcpControlRendererEvent(operation, result, args, source);
        if (event) sendToRenderer(IPC.event.sessionsChanged, event);
      },
    });
    state.desktopControl = control;
    plugins.setServices({ desktopControl: control });
    // Load the local model snapshot immediately. A changed APP_VERSION marks
    // the snapshot stale, so every release performs one bounded update without
    // blocking the first window; Settings can force the same refresh on demand.
    void modelsDevCatalog.ensureLoaded();
    let bootError: unknown = null;
    try {
      await bootBackends();
    } catch (error) {
      bootError = error;
      logger.app("runtime", "error", "backend boot failed", {
        code: ErrorCodes.HOST_UNAVAILABLE,
        data: String(error),
      });
    }
    if (!bootError) planUiProbe.install();
    if (!bootError && state.agentHostBridge) {
      // Restore the persisted turn queue now that host-core answers. Restored
      // entries stay held until a controller attaches (D375).
      state.agentHostBridge.agentHost.start().catch((error) => {
        logger.app("runtime", "warn", "agent host queue restore failed", {
          data: String(error),
        });
      });
    }
    const host = getHost();
    if (host) {
      try {
        const stored = (await host.call("settings.get")) as {
          language?: unknown;
          theme?: unknown;
          keybindings?: unknown;
          developerMode?: unknown;
        } | null;
        applyApplicationMenuSettings(stored);
        applyDeveloperMode(stored);
        await applyNetworkProxyFromAppSettings(stored);
      } catch {
        // Keep the OS-locale menu until settings can be read again, while
        // retaining the historical default launcher fallback for this failure.
        applyPluginLauncherShortcut();
        applySummonWindowShortcut();
      }
    } else {
      // If the backend never started, retain the default focused/global path.
      applyPluginLauncherShortcut();
      applySummonWindowShortcut();
    }
    await ensureWindow();
    if (process.env.PI_DESKTOP_MCP_CONTROL === "1") {
      try {
        state.mcpControl = new McpControlServer({
          dataDir,
          invoke: invokeIpc,
          channels: IPC.invoke,
          version: APP_VERSION,
          port: process.env.PI_DESKTOP_MCP_PORT
            ? Number(process.env.PI_DESKTOP_MCP_PORT)
            : undefined,
          controller: state.desktopControl ?? undefined,
          log: (level, message, data) => logger.app("runtime", level, message, { data }),
        });
        await state.mcpControl.start();
      } catch (error) {
        logger.app("runtime", "warn", "MCP control server failed to start", {
          data: String(error),
        });
        state.mcpControl = null;
      }
    }
    // GitHub discovery is delayed and time-bounded. Never start it before the
    // first window exists: a hung feed used to sit in "checking" for ~60s and
    // compete with boot for the net stack.
    updater.startAutoCheck();
    // createWindow awaits the initial load (loadFile resolves on
    // did-finish-load), so the page is up; give React a beat to mount its
    // event subscriptions before pushing the boot outcome.
    setTimeout(() => {
      sendToRenderer(IPC.event.hostStatus, bootHostStatus(bootError));
      state.applicationBooted = true;
      flushPendingApplicationMenuCommands();
    }, 300);

    // Headless boot probe for automated e2e (scripts/e2e-electron-boot.mjs):
    // verifies sandboxed preload bridge + a full IPC round-trip, then quits.
    if (process.env.PI_DESKTOP_BOOT_PROBE === "1") {
      setTimeout(() => {
        void (async () => {
          try {
            const window = getMainWindow();
            const probe = await window!.webContents.executeJavaScript(
              `(async () => {
               const api = window.piDesktop;
               if (!api || typeof api.invoke !== "function") {
                 return { ok: false, reason: "preload api missing" };
               }
               const version = await api.invoke(api.channels.invoke.appGetVersion);
               const windowState =
                 api.platform === "darwin"
                   ? null
                   : await api.invoke(api.channels.invoke.windowControl, {
                       action: "getState",
                     });
               return {
                 ok: version?.ok === true,
                 version: version?.data?.version,
                 hostProtocol: version?.data?.hostProtocolVersion,
                 platform: api.platform,
                 maximized: windowState?.data?.maximized ?? null,
               };
             })()`,
            );
            probe.appName = app.getName();
            probe.menuCount = Menu.getApplicationMenu()?.items.length ?? 0;
            if (!host || !window) throw new Error("session-list probe requires a healthy desktop");
            probe.sessionList = await runSessionListProbe({
              dataDir,
              host,
              window,
              catalog: modelsDevCatalog,
            });
            console.log("BOOT_PROBE", JSON.stringify(probe));
          } catch (error) {
            console.log(
              "BOOT_PROBE",
              JSON.stringify({ ok: false, reason: String(error) }),
            );
          } finally {
            app.quit();
          }
        })();
      }, 800);
    }
    // Supervision probe (scripts/e2e-supervision.mjs): SIGKILL our own
    // host-core child, then assert the supervisor brings a fresh one back
    // that answers RPCs. Deterministic crash-recovery e2e without pid hunts.
    if (process.env.PI_DESKTOP_SUPERVISION_PROBE === "1") {
      const initialHost = getHost();
      setTimeout(() => {
        logger.app("runtime", "info", "supervision probe: killing host-core");
        (initialHost as any)?.child?.kill("SIGKILL");
      }, 1500);
      const startedAt = Date.now();
      const poll = setInterval(() => {
        void (async () => {
          if (Date.now() - startedAt > 30_000) {
            clearInterval(poll);
            console.log(
              "SUPERVISION_PROBE",
              JSON.stringify({ ok: false, reason: "timeout" }),
            );
            app.quit();
            return;
          }
          const currentHost = getHost();
          if (!currentHost || currentHost === initialHost) return;
          try {
            const health = await currentHost.call<{ ok: boolean }>("app.health");
            clearInterval(poll);
            console.log(
              "SUPERVISION_PROBE",
              JSON.stringify({ ok: health.ok === true, restarted: true }),
            );
            app.quit();
          } catch {
            // restart still settling; keep polling
          }
        })();
      }, 500);
    }
  });
}
