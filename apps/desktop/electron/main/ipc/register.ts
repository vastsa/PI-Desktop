import { join } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { registerAgentIpc } from "./agent-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import { searchMcpRegistry } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerProviderIpc } from "./provider-ipc";
import { registerPullsIpc } from "./pulls-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerWindowIpc } from "./window-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import type { IpcRegistrar } from "./types";

export type RegisterIpcDependencies = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  [name: string]: any;
};

export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    wrap,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
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
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
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
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    markMenuRendererReady,
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
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
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
  } = dependencies;


  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    ipcHandlers.set(channel, fn);
    ipcMain.handle(channel, async (_event, ...args) => wrap(() => fn(...args)));
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
    resolveEffectiveCommandShell,
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
  });
  registerWorkspaceIpc({
    registrar,
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
    importRoot: join(dataDir, "plugins", "imported"),
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
    logger,
    vendorOAuth,
    agentExtensions,
    persistenceOutbox,
    dataDir,
    activeTurns,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    finishTurn,
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
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpRegistry,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    stripWinLongPrefix,
    sendToRenderer,
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
