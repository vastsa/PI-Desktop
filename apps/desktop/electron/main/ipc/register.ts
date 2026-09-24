import { join } from "node:path";
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { err, ErrorCodes, IPC, ok, type Result } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { ROUTE_LOCAL, type BackendRouter } from "../remote/backend-router";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { readNpmPath, writeNpmPath } from "../npm-preferences";
import { registerAgentIpc } from "./agent-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import type { McpOAuthManager } from "../mcp-oauth";
import { searchMcpMarket } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerProviderIpc } from "./provider-ipc";
import { registerPullsIpc } from "./pulls-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerConfigSyncIpc } from "./config-sync-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAgentImportIpc } from "./agent-import-ipc";
import { registerRemoteHostIpc } from "./remote-host-ipc";
import { fetchSkillMarketDocument, searchSkillMarket } from "../skill-market-catalog";
import { registerWindowIpc } from "./window-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import { registerSpeechIpc } from "./speech-ipc";
import { registerVoiceIpc } from "./voice-ipc";
import type { IpcRegistrar } from "./types";
import type { createTraySessions } from "../tray-sessions";

export type RegisterIpcDependencies = {
  isQuitting: () => boolean;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  traySessions: ReturnType<typeof createTraySessions>;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  /**
   * Resolves the remote backend router once it exists. Renderer IPC calls whose
   * session is owned by a paired remote host are forwarded through it; every
   * other call — including all internal invokes — runs the local handler
   * unchanged. Null until the router is wired (and in tests).
   */
  getBackendRouter?: () => BackendRouter | null;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  disabledBuiltinSubagents: () => Promise<string[]>;
  mcpOAuth?: McpOAuthManager;
  [name: string]: any;
};

function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn()
    .then((data) => ok(data))
    .catch((e: any) =>
      err(
        e?.data?.errorCode || e?.errorCode || ErrorCodes.INTERNAL,
        e instanceof Error ? e.message : String(e),
        { retriable: e?.data?.retriable === true, details: e?.data },
      ),
    );
}

export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge,
    getBackendRouter,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
    dataDir,
    activeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    stripWinLongPrefix,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    resolveEffectiveCommandShell,
    modelsDevCatalog,
    vendorOAuth,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    agentExtensions,
    activeUserSkills,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    markMenuRendererReady,
    traySessions,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isDevelopmentBuild,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
    mcpOAuth,
    refreshUserMcp,
    describeError,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale,
    getPluginPanelTheme,
    isDeveloperMode,
    sendToRenderer,
    voiceService,
  } = dependencies;


  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    const handler = async (...args: any[]) => {
      const result = await fn(...args);
      traySessions.observeInvoke(channel);
      return result;
    };
    ipcHandlers.set(channel, handler);
    // The interception seam for remote-host routing: a renderer call whose
    // session is owned by a paired remote host is served over RACP-WS; every
    // other call (and every internal invoke, which never reaches this wrapper)
    // runs the existing local handler byte-for-byte unchanged.
    ipcMain.handle(channel, async (_event, ...args) =>
      wrap(async () => {
        const router = getBackendRouter?.();
        if (router) {
          const outcome = await router.route(channel, args);
          if (outcome !== ROUTE_LOCAL) return outcome.value;
        }
        return handler(...args);
      }),
    );
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) =>
      wrap(() => fn(event, ...args)),
    );
  };
  const assertMainWindowSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== getMainWindow()?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    const currentHost = getHost();
    if (!currentHost) return null;
    try {
      const result = (await currentHost.call("workspace.get")) as {
        workspace: { path?: string } | null;
      };
      return result.workspace?.path ?? null;
    } catch {
      return null;
    }
  };

  const registrar: IpcRegistrar = {
    ipcMain,
    handle,
    handleWithEvent,
    assertMainWindowSender,
  };

  registerAppIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
  });
  registerNotificationIpc({
    registrar,
    getHost,
    getMainWindow,
    getViewingSessionId: getNotificationViewingSessionId,
    setViewingSessionId: setNotificationViewingSessionId,
    sendToRenderer,
  });
  registerSessionIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    activeTurns,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    stripWinLongPrefix,
  });
  registerSettingsIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    resolveEffectiveCommandShell,
  });
  registerConfigSyncIpc({
    registrar,
    getHost,
    sendToRenderer,
  });
  registerProviderIpc({
    registrar,
    getHost,
    modelsDevCatalog,
    vendorOAuth,
    logger,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
  });
  const loadComposerTemplatesCached = createComposerTemplateLoader(logger);
  const composerCommandService = registerComposerIpc({
    registrar,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    activeUserSkills,
    pluginActiveInProject,
    loadComposerTemplatesCached,
  });
  registerWindowIpc({
    setTraySessionPreferences: traySessions.setPreferences,
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
  });
  registerPullsIpc({ registrar, getHost });
  registerScheduledIpc({
    registrar,
    getHost,
    scheduledRunsBySession,
    isQuitting: dependencies.isQuitting,
    invoke: async (channel, args) => {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error("scheduled prompt handler unavailable");
      return handler(...args);
    },
  });
  registerWorkspaceIpc({
    registrar,
    getMainWindow,
    getHost,
    getSidecar,
    dataDir,
    isDevelopmentBuild,
    plugins,
    browserHost,
    clipboardHistory,
    logger,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    stripWinLongPrefix,
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: getMainWindow,
    dialogs: dialog,
    getLocale: getUpdaterLocale,
    getNpmPath: () => readNpmPath(dataDir),
    setNpmPath: (path) => writeNpmPath(dataDir, path),
    importRoot: join(dataDir, "plugins", "imported"),
    getImportedDescriptions: async () => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const { plugins: registered } = await currentHost.call<{ plugins: import("@pi-desktop/shared").PluginSummary[] }>("plugins.list");
      return registered.flatMap(plugin => plugin.description ? [plugin.description] : []);
    },
    loadDevPlugin: async (path) => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const loaded = await currentHost.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: async (input) => {
      const currentSidecar = getSidecar();
      if (!currentSidecar) throw new Error("agent sidecar unavailable");
      return currentSidecar.call<{ handled: boolean }>("extensions.command.run", input);
    },
  });
  registerAgentIpc({
    registrar,
    getHost,
    getSidecar,
    getAgentHostBridge,
    cancelSessionTools: (sessionId: string, reason?: string) => {
      plugins.cancelSessionTools(sessionId, reason);
      userMcp.cancelSessionCalls(sessionId);
    },
    logger,
    vendorOAuth,
    agentExtensions,
    persistenceOutbox,
    dataDir,
    activeTurns,
    isTurnDispatchable,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    setNotificationViewingSessionId,
    optionalWorkspaceRoot,
    composerCommandService,
    loadComposerTemplatesCached,
  });

  registerPluginIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    browserHost,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    sendToRenderer,
    logger,
  });


  registerMcpIpc({
    registrar,
    getHost,
    userMcp,
    oauth: mcpOAuth,
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpMarket,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    searchSkillMarket,
    fetchSkillMarketDocument,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    stripWinLongPrefix,
    sendToRenderer,
    logger,
  });


  registerAgentImportIpc({
    registrar,
    getHost,
    sendToRenderer,
    refreshUserMcp,
    currentWorkspacePath,
  });


  registerPluginUiIpc({
    registrar,
    plugins,
    browserHost,
    pluginViews,
    pluginPanels,
    pluginActiveInProject,
    currentWorkspacePath,
    getUpdaterLocale,
    getPluginPanelTheme,
  });

  registerSpeechIpc({ registrar, speech });

  if (voiceService) {
    registerVoiceIpc({ registrar, voiceService });
  }

  registerRemoteHostIpc({ registrar });

  registerMarketIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    pluginActiveInProject,
    sendToRenderer,
  });


  registerDiagnosticsIpc({
    registrar,
    dataDir,
    stripWinLongPrefix,
    isDeveloperMode,
    getMainWindow,
  });


  return async (channel: string, args: readonly unknown[] = []) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw Object.assign(new Error(`IPC channel is not available to external agents: ${channel}`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return handler(...args);
  };
}
