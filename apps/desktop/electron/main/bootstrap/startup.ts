import { app, BrowserWindow, crashReporter, Menu, safeStorage } from "electron";
import { createScheduledRunner } from "../runtime/scheduled-runner";
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
import {
  installPluginAssetProtocol,
  registerPluginAssetScheme,
} from "../plugin-asset-protocol";
import { applyNetworkProxyFromAppSettings } from "../network-proxy";
import { readCloseBehavior } from "../window-preferences";
import { createAgentHostBridge, type AgentHostBridge } from "../agent-host-bridge";
import { createBackendRouter, type BackendRouter } from "../remote/backend-router";
import { createRemoteHostsBoot, setActiveRemoteHostsBoot } from "./remote-hosts";
import {
  createMcpControlController,
  McpControlServer,
  mcpControlRendererEvent,
  type McpControlController,
  type McpControlInvokeInput,
} from "../mcp-control";
import type { ModelsDevCatalog } from "../models-dev-catalog";
import type { AppUpdaterController } from "../updater";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import { runSessionListProbe } from "../session-list-probe";
import {
  ensureCrashDumpsDirectory,
  reportPreviousCrashDumps,
} from "../crash-report";

type IpcInvoker = (
  channel: string,
  args?: readonly unknown[],
) => Promise<unknown>;

/**
 * The remote-host modules pass their log `data` as a structured object (e.g.
 * `{hostKey, error}`); a bare `String(data)` prints `[object Object]` and
 * loses the context. Errors keep their `String(error)` shape ("Error: ..."),
 * plain strings pass through, everything else JSON-stringifies.
 */
function formatRemoteLogData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data === "string") return data;
  if (data instanceof Error) return String(data);
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export type StartupState = {
  applicationBooted: boolean;
  closeBehavior: CloseBehavior;
  agentHostBridge: AgentHostBridge | null;
  backendRouter: BackendRouter | null;
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
  /**
   * Shared busy check from `runtime/session-coordination.ts`. The queue must
   * stay held while a turn's announcement is still running, so this cannot be
   * derived here from `activeTurns` alone.
   */
  isSessionBusy: (sessionId: string) => boolean;
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
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyPluginLauncherShortcut: (keybindings?: KeybindingOverrides) => void;
  applyToggleWindowShortcut: (keybindings?: KeybindingOverrides) => void;
  ensureWindow: () => Promise<boolean>;
  bootHostStatus: (bootError: unknown) => unknown;
  flushPendingApplicationMenuCommands: () => void;
  getSidecar?: () => unknown;
  invokeSessionCollaboration?: (input: McpControlInvokeInput) => Promise<unknown>;
  onSessionQueueChange?: () => void;
};

/**
 * Register the Electron-ready boot sequence. The sequence remains deliberately
 * ordered here, while its mutable process resources are supplied by the main
 * composition root through `StartupState` and dependency callbacks.
 */
export function registerApplicationStartup(deps: StartupDependencies): void {
  // Electron only accepts scheme privileges before the app is ready, and this
  // runs from the composition root, before the `whenReady` promise can settle.
  registerPluginAssetScheme();
  // Crashpad ships with Electron, so the reporter needs no native dependency.
  // Dumps stay local (`uploadToServer: false`) under the installation data
  // directory so a `PI_DESKTOP_DATA_DIR` profile does not share them. Started
  // before `ready`, so no crash can happen ahead of the handler. A failure
  // here is a warning: it never blocks boot.
  try {
    app.setPath("crashDumps", ensureCrashDumpsDirectory(deps.dataDir));
    crashReporter.start({ uploadToServer: false, productName: APP_NAME });
  } catch (error) {
    deps.logger.app("diagnostics", "warn", "crash reporter failed to start", {
      event: "crashReporterStartFailed",
      data: String(error),
    });
  }


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
      isSessionBusy,
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
      applyPreventScreenSleep,
      applyKeepAwakeWhileRunning,
      applyPluginLauncherShortcut,
      applyToggleWindowShortcut,
      ensureWindow,
      bootHostStatus,
      flushPendingApplicationMenuCommands,
    } = deps;

    // A launch that lost the single-instance lock is already quitting. Never
    // create a window, a tray, or a child process on top of the running app.
    if (!hasSingleInstanceLock) return;
    applyDevelopmentBranding();

    // A Chromium-process crash from a previous run left a minidump, and nothing
    // else would ever mention it. Report one durable line per new dump set,
    // classified by process type, then advance the marker. Reporting is
    // diagnostics: a failure warns and is dropped rather than holding up the
    // first window.
    reportPreviousCrashDumps({
      dataDir,
      crashDumpsDirectory: app.getPath("crashDumps"),
      logger,
    });

    // Serve declared theme assets before the renderer can ask for one; the
    // scheme itself was reserved in `registerApplicationStartup`.
    installPluginAssetProtocol((pluginId, assetPath) =>
      plugins.resolveThemeAsset(pluginId, assetPath),
    );
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
    // The backend router is the single seam that forwards a renderer IPC call
    // to a paired remote host; with no remote session registered it returns
    // ROUTE_LOCAL and the local handler runs unchanged. Assigned before the
    // first window can issue IPC. Remote host connections register their
    // sessions here once paired (later stages).
    state.backendRouter = createBackendRouter({
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    // Every paired remote `pi-host` opens against the router this boot just
    // created. An empty registry (default install with no user pairing) makes
    // this a full no-op — nothing connects, no backend registers, every
    // renderer call keeps hitting the local handler byte-for-byte.
    const remoteHostsBoot = createRemoteHostsBoot({
      dataDir,
      encryption: {
        // Electron's safeStorage exposes `isEncryptionAvailable`; the port
        // keeps the shorter `isAvailable` name so a Node-side test can drop
        // in a fake without pulling in the Electron type.
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (buffer) => safeStorage.decryptString(buffer),
      },
      router: state.backendRouter,
      emit: sendToRenderer,
      clientInfo: { name: APP_NAME, version: APP_VERSION },
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    setActiveRemoteHostsBoot(remoteHostsBoot);
    // Boot in the background: a slow or unreachable host must not delay the
    // first window. Failures for individual hosts are logged inside `open()`.
    void remoteHostsBoot.open().then((opened) => {
      if (opened > 0) {
        logger.app("runtime", "info", "remote hosts connected", { data: String(opened) });
      }
    });
    state.agentHostBridge = createAgentHostBridge({
      invoke: invokeIpc,
      channels: IPC.invoke,
      getHost,
      isSessionBusy,
      onQueueChange: (event) => {
        sendToRenderer(IPC.event.agentQueueChanged, event);
        deps.onSessionQueueChange?.();
      },
      log: (level, message, data) => logger.app("runtime", level, message, { data }),
    });
    const control = createMcpControlController({
      invoke: invokeIpc,
      channels: IPC.invoke,
      invokeSessionCollaboration: deps.invokeSessionCollaboration,
      onOperationComplete: async (operation, result, args, source) => {
        const event = mcpControlRendererEvent(operation, result, args, source);
        if (event) sendToRenderer(IPC.event.sessionsChanged, event);
      },
    });
    state.desktopControl = control;
    plugins.setServices({ desktopControl: control });
    // Load the bundled model snapshot at startup without blocking the first
    // window. Startup neither fetches nor rewrites the catalog; the snapshot
    // is refreshed on demand from Settings (see models-dev-catalog / the
    // 13-model-catalog-and-selection spec).
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
    const scheduledRunner = createScheduledRunner({
      getHost,
      execute: (id) => invokeIpc(IPC.invoke.scheduledExecute, [id, true]),
      report: (error) => logger.app("runtime", "warn", "scheduled task dispatch failed", { data: String(error) }),
    });
    scheduledRunner.start();
    app.once("before-quit", () => scheduledRunner.stop());
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
          preventScreenSleep?: unknown;
          keepAwakeWhileRunning?: unknown;
        } | null;
        applyApplicationMenuSettings(stored);
        applyDeveloperMode(stored);
        applyPreventScreenSleep(stored);
        applyKeepAwakeWhileRunning(stored);
        await applyNetworkProxyFromAppSettings(stored);
      } catch {
        // Keep the OS-locale menu until settings can be read again, while
        // retaining the historical default launcher fallback for this failure.
        applyPluginLauncherShortcut();
        applyPluginLauncherShortcut();
        applyToggleWindowShortcut();
      }
    } else {
      // If the backend never started, retain the default focused/global path.
      applyPluginLauncherShortcut();
      applyToggleWindowShortcut();
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
               // Project removal channel: a path that cannot have a durable row
               // still has to survive preload -> main -> host-core and come back
               // as the documented idempotent no-op.
               const projectRemove = await api.invoke(
                 api.channels.invoke.projectRemove,
                 { path: "pi-desktop-boot-probe-unknown-project" },
               );
               return {
                 ok: version?.ok === true,
                 version: version?.data?.version,
                 hostProtocol: version?.data?.hostProtocolVersion,
                 platform: api.platform,
                 maximized: windowState?.data?.maximized ?? null,
                 projectRemove: {
                   ok: projectRemove?.ok === true,
                   removed: projectRemove?.data?.removed ?? null,
                   sessionsRemoved: projectRemove?.data?.sessionsRemoved ?? null,
                 },
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
