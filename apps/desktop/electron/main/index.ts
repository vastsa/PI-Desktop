import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  Tray,
} from "electron";
import { join } from "node:path";
import {
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  testNetworkProxy,
} from "./network-proxy";
import { installInsecureEndpointNotice } from "./network-notice";
import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  IPC,
  IPC_WHITELIST,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  isActiveInProject,
  type ActivationScope,
  type AgentEventEnvelope,
  type AppMenuCommand,
  type CloseBehavior,
  type KeybindingOverrides,
  type PlanExecutionFinishStatus,
} from "@pi-desktop/shared";
import { summarizeSessionTitle } from "@pi-desktop/agent-runtime";
import { AgentExtensionBridge } from "./agent-extensions";
import { registerAgentExtensionIpc } from "./agent-extensions-ipc";
import { isTemplateName, scaffold } from "@pi-desktop/plugin-devkit";

import { HostProcess } from "./host-process";
import {
  knownProjectGroups,
  pluginWorkspaceInfo,
  refreshProjectGroups,
} from "./workspace-roots";
import {
  shouldCreateTaskNotification as shouldCreateTaskNotificationPolicy,
  shouldShowNativeNotification,
} from "./notification-policy";
import { PersistenceOutbox } from "./persistence-outbox";
import { AgentSidecar } from "./agent-sidecar";
import { Logger, ignoreBrokenStdio } from "./logger";
import { describeError, installMainProcessErrorHandlers } from "./main-process-errors";
import {
  isDbSchemaTooNewError,
} from "./host-boot-diagnostics";
import {
  ModelsDevCatalog,
  catalogModelConfigFor,
} from "./models-dev-catalog";
import { VendorOAuth } from "./oauth";
import { AppUpdaterController } from "./updater";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import {
  baseWindowBounds,
  clampBoundsOriginToWorkArea,
  displayWorkAreaKey,
  emptyWorkPanelReservationState,
  isWorkPanelOuterResizeEdge,
  parseWorkPanelChatWidth,
  parseWorkPanelReservationWidth,
  planWorkPanelChatResize,
  planWorkPanelReservation,
  reconcileBaseWindowBounds,
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  windowBoundsEqual,
  type DisplayTransition,
  type WindowBounds,
  type WorkPanelReservationState,
} from "./work-panel-window";
import {
  appendPromptFallbackPaths,
  durableUserMessageId,
  preparePromptAttachments,
  type PreparedPromptAttachment,
} from "./prompt-attachments";
import {
  InflightCheckpointer,
  executionFromResponse,
  executionListFromResponse,
  planExecutionFromUnknown,
} from "@pi-desktop/host-runtime";
import { readWindowState, writeWindowState } from "./window-preferences";
import { withGitBranch } from "./workspace-git";
import { applyDevelopmentUserData, desktopDataDir } from "./data-paths";
import { createPlanUiProbe } from "./plan-ui-probe";
import type { McpControlController, McpControlServer } from "./mcp-control";
import type { AgentHostBridge } from "./agent-host-bridge";
import { registerAppIpc } from "./ipc/app-ipc";
import { registerNotificationIpc } from "./ipc/notification-ipc";
import { registerSessionIpc } from "./ipc/session-ipc";
import { registerSettingsIpc } from "./ipc/settings-ipc";
import { registerProviderIpc } from "./ipc/provider-ipc";
import {
  createComposerTemplateLoader,
  registerWorkspaceIpc,
} from "./ipc/workspace-ipc";
import {
  registerComposerIpc,
} from "./ipc/composer-ipc";
import { registerWindowIpc } from "./ipc/window-ipc";
import { registerPullsIpc } from "./ipc/pulls-ipc";
import { registerAgentIpc } from "./ipc/agent-ipc";
import { registerIpcHandlers } from "./ipc/register";
import { createVoiceService } from "./voice-service";
import { MainProcessState } from "./bootstrap/main-state";
import {
  type WindowLifecycleState,
} from "./bootstrap/window";
import { registerApplicationActivation } from "./bootstrap/app-activation";
import type { RuntimeState } from "./runtime/context";
import { createHostRuntime } from "./runtime/host";
import { createSidecarRuntime } from "./runtime/sidecar";
import { createEventPersistence } from "./runtime/event-persistence";
import { createPlanRuntime, type PlanRuntimeState } from "./runtime/plans";
import { createRuntimeLifecycle } from "./runtime/lifecycle";
import {
  createProviderCatalogRuntime,
} from "./runtime/provider-catalog";
import { createSessionLaunchRuntime } from "./runtime/session-launch";
import { createSessionCoordination } from "./runtime/session-coordination";
import { createScheduledRuntime } from "./runtime/scheduled";
import { createDesktopServices } from "./services/desktop-services";
import { createPluginServices } from "./services/plugin-services";
import { wirePluginThemeRuntimeServices } from "./plugin-theme-services";
import { createSessionCollaborationService } from "./services/session-collaboration";
import {
  createApplicationLifecycle,
  type ApplicationAppearanceState,
  type ApplicationLifecycleState,
} from "./bootstrap/app-lifecycle";
import {
  registerApplicationStartup,
  type StartupState,
} from "./bootstrap/startup";
import {
  createLauncher,
  type LauncherState,
} from "./bootstrap/launcher";
import { createWorkPanelRuntime } from "./bootstrap/work-panel";
import { createCloseBehaviorRuntime } from "./bootstrap/close-behavior";
import { registerShutdownHandlers, type ShutdownState } from "./bootstrap/shutdown";
import { registerDiagnosticsIpc } from "./ipc/diagnostics-ipc";
import { registerMarketIpc } from "./ipc/market-ipc";
import { registerMcpIpc } from "./ipc/mcp-ipc";
import { registerPluginIpc } from "./ipc/plugin-ipc";
import { registerPluginUiIpc } from "./ipc/plugin-ui-ipc";
import { registerSkillsIpc } from "./ipc/skills-ipc";
import { stripWinLongPrefix } from "./path-utils";

// A closed stdout/stderr (Linux AppImage, GUI launch without a TTY) must not
// surface as Electron's "Uncaught Exception: write EPIPE" dialog. The same
// default dialog must not appear for a stray uncaughtException (non-ASCII
// HTTP headers from a system proxy, destroyed webContents, etc.).
ignoreBrokenStdio();
installMainProcessErrorHandlers();

const isDevelopmentBuild =
  process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;

app.setName(APP_NAME);
applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

// Chromium's accessibility tree serializer has a known CHECK failure in
// AXBlockFlowData::ComputeNeighborOnLine (chromium #552018997) that kills
// the renderer when an AT client reads the tree while the DOM is being
// mutated — exactly what happens during streaming agent responses.
// The switch prevents Chromium from building the in-renderer accessibility
// tree unless the user explicitly opts in via --force-renderer-accessibility.
// This is a workaround until the upstream fix lands.
app.commandLine.appendSwitch("disable-renderer-accessibility");

// One installation, one process. The lock lives in `userData` (set just
// above), so it is taken after `setName` and before anything else here
// touches the data directory. A development build is its own installation;
// `PI_DESKTOP_DATA_DIR` still opts a run out of the lock (E2E, capture rig).
const singleInstanceRequired = !process.env.PI_DESKTOP_DATA_DIR;
const hasSingleInstanceLock = singleInstanceRequired
  ? app.requestSingleInstanceLock()
  : true;
if (!hasSingleInstanceLock) {
  // Nothing has booted yet: no window, no tray, no child process, no log line.
  // Quit here and let the instance that holds the lock surface itself from
  // `second-instance`.
  app.quit();
}

const WINDOW_MIN_WIDTH = 1040;
const WINDOW_MIN_HEIGHT = 700;
// Native resize streams can pause briefly while the pointer crosses a display
// scale boundary. Keep recovery out of that gesture and only run it after the
// bounds have been stable for one short interaction window.
const WINDOW_BOUNDS_SETTLE_MS = 300;
const WORK_PANEL_NATIVE_RESIZE_SETTLE_MS = 180;
const WORK_PANEL_CHAT_RESIZE_SETTLE_MS = WINDOW_BOUNDS_SETTLE_MS + 120;

const mainState = new MainProcessState();
const {
  launcherState,
  windowLifecycleState,
  runtimeState,
  applicationLifecycleState,
  applicationAppearanceState,
  planRuntimeState,
  startupState,
  shutdownState,
  windowsAllowedToClose,
} = mainState;

const getHost = () => mainState.host;
const getMainWindow = () => mainState.mainWindow;
const getSidecar = () => mainState.sidecar;

let applicationLifecycle: ReturnType<typeof createApplicationLifecycle> | null = null;
let launcherRuntime: ReturnType<typeof createLauncher> | null = null;
let closeBehaviorRuntime: ReturnType<typeof createCloseBehaviorRuntime> | null = null;
const showPluginLauncherForLifecycle = (): Promise<void> => {
  if (!launcherRuntime) {
    return Promise.reject(new Error("launcher is not initialized"));
  }
  return launcherRuntime.showPluginLauncher();
};
const applyPluginLauncherShortcutForLifecycle = (
  keybindings?: KeybindingOverrides,
) => {
  launcherRuntime?.applyPluginLauncherShortcut(keybindings);
};
const applyToggleWindowShortcutForLifecycle = (
  keybindings?: KeybindingOverrides,
) => {
  launcherRuntime?.applyToggleWindowShortcut(keybindings);
};
const applyCloseBehaviorForLifecycle = (next: CloseBehavior) => {
  if (!closeBehaviorRuntime) {
    throw new Error("close behavior runtime is not initialized");
  }
  closeBehaviorRuntime.applyCloseBehavior(next);
};
const askCloseBehaviorForLifecycle = (
  window: BrowserWindow,
): Promise<CloseBehavior | null> => {
  if (!closeBehaviorRuntime) {
    return Promise.reject(new Error("close behavior runtime is not initialized"));
  }
  return closeBehaviorRuntime.askCloseBehavior(window);
};

const workPanelRuntime = createWorkPanelRuntime({
  state: windowLifecycleState,
  windowMinWidth: WINDOW_MIN_WIDTH,
  chatResizeSettleMs: WORK_PANEL_CHAT_RESIZE_SETTLE_MS,
});
const {
  workPanelMinimumWindowWidth,
  observedWorkPanelBaseBounds,
  markWorkPanelChatResizeActive,
  classifyDisplayTransition,
  applyWorkPanelReservation,
} = workPanelRuntime;

const desktopServices = createDesktopServices({
  getLogger: () => logger,
  getMainWindow,
});
const {
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  recordPastedClipboardFiles,
  safeOpenExternal,
} = desktopServices;

const dataDir = desktopDataDir(isDevelopmentBuild);
// The plugin runtime resolves this root from the environment rather than taking
// it as a parameter, and a profile split across two directories is the
// divergence D236 closes.
process.env.PI_DESKTOP_DATA_DIR = dataDir;

// Agent extensions (D387/D388, ADR 0214): plugins contribute the modules,
// the sidecar loads them; this bridge carries commands, diagnostics, and
// prompts between the two.
const agentExtensions = new AgentExtensionBridge({
  hasRenderer: () =>
    !!mainState.mainWindow &&
    !mainState.mainWindow.isDestroyed() &&
    !mainState.mainWindow.webContents.isDestroyed(),
  onChanged: () => sendToRenderer(IPC.event.pluginChanged, { reason: "agentExtensions" }),
  onPrompt: (prompt) => {
    logger.app("plugin", "info", "extension prompt", {
      sessionId: prompt.sessionId,
      data: { promptId: prompt.promptId, kind: prompt.request.kind, extensionId: prompt.extensionId },
    });
    sendToRenderer(IPC.event.extensionsUiPrompt, prompt);
  },
  onToast: (message) => sendToRenderer(IPC.event.toast, { message }),
  onStatus: (event) => sendToRenderer(IPC.event.extensionsStatus, event),
});

const logger = new Logger(
  dataDir,
  isDevelopmentBuild ? "debug" : "info",
  { mirrorConsole: isDevelopmentBuild },
);
installMainProcessErrorHandlers({
  emit: (record) => {
    logger.app("runtime", "error", record.message, {
      code: record.code,
      data: { recoverable: record.recoverable, detail: record.detail },
    });
  },
});

const persistenceOutbox = new PersistenceOutbox(dataDir, (level, message, data) => {
  logger.app("persistence", level, message, { data });
});
const steeringReplies = new Set<string>();
const scheduledRuntime = createScheduledRuntime({
  dataDir,
  getHost,
  logger,
});
const { importLegacyScheduled } = scheduledRuntime;
// The reply currently streaming in each session, checkpointed to host-core so
// a quit or crash mid-reply keeps the text the user already saw (D299). A
// checkpoint is a best-effort write against a live host; the outbox is not
// involved because a stale checkpoint must never be replayed after the final
// row.
const inflightCheckpointer = new InflightCheckpointer(async (checkpoint) => {
  if (!mainState.host || !mainState.host.isAvailable()) return;
  await mainState.host.call(
    "session.saveInflightMessage",
    {
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      message: checkpoint.message,
    },
    5_000,
  );
});

const updater = new AppUpdaterController({
  logger,
  send: sendToRenderer,
  currentVersion: APP_VERSION,
  isPackaged: !isDevelopmentBuild,
  getLocale: () => mainState.updaterLocale,
});

/**
 * Vendor-account logins. Holds the pi-ai credential plumbing so tokens stay in
 * this process; the renderer sees progress events and the sidecar sees only
 * resolved request auth.
 */
const modelsDevCatalog = new ModelsDevCatalog({
  catalogPath: app.isPackaged
    ? join(process.resourcesPath, "models.dev", "api.json")
    : join(app.getAppPath(), "resources", "models.dev", "api.json"),
});

const vendorOAuth = new VendorOAuth({
  call: <T,>(method: string, params?: unknown): Promise<T> => {
    const currentHost = getHost();
    if (!currentHost) throw new Error("host unavailable");
    return currentHost.call<T>(method, params);
  },
  emit: (event) => sendToRenderer(IPC.event.providersOauth, event),
  openExternal: async (url) => {
    await safeOpenExternal(url);
  },
  log: (level, message, data) => logger.app("provider", level, message, { data }),
  modelConfigFor: async ({ vendorKey, option }) => {
    await modelsDevCatalog.ensureLoaded();
    return catalogModelConfigFor(modelsDevCatalog, {
      vendorKey,
      baseUrl: option.baseUrl,
      apiStyle: option.apiStyle,
      modelId: option.modelId,
    });
  },
});

let sessionLaunchRuntime: ReturnType<typeof createSessionLaunchRuntime> | null = null;
const pluginServices = createPluginServices({
  dataDir,
  logger,
  getMainWindow,
  getHost,
  sendToRenderer,
  safeOpenExternal,
  stripWinLongPrefix,
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  getUpdaterLocale: () => mainState.updaterLocale,
  getPluginPanelTheme: () => mainState.pluginPanelTheme,
  getAppearance: () => {
    if (!applicationLifecycle) {
      throw new Error("application lifecycle is not initialized");
    }
    return applicationLifecycle.resolveAppearance();
  },
  getWorkspacePath: currentWorkspacePath,
  resolveAgentRuntimeLaunch: (...args) => {
    if (!sessionLaunchRuntime) {
      throw new Error("session launch runtime is not initialized");
    }
    return (
      sessionLaunchRuntime.resolveAgentRuntimeLaunch as (
        ...args: any[]
      ) => Promise<any>
    )(...args);
  },
  vendorOAuth,
  agentExtensions,
});
const {
  plugins,
  userMcp,
  mcpOAuth,
  pluginScopes,
  sessionProjects,
  emitBrowserState,
  pluginPanels,
  pluginViews,
  browserHost,
  browserPane,
  announceTurnEnded,
  speech,
} = pluginServices;

const providerCatalogRuntime = createProviderCatalogRuntime({
  getHost,
  modelsDevCatalog,
});
const {
  bindingForModel,
  effectiveSubagentModelConfig,
  enrichProvider,
  enrichProviderList,
  sessionCapabilityContext,
  enrichSession,
  normalizeSettings,
  validateSettingsWrite,
  normalizeThinkingLevel,
  listRuntimeProviders,
} = providerCatalogRuntime;

const createdSessionLaunchRuntime = createSessionLaunchRuntime({
  runtimeState,
  logger,
  userMcp,
  plugins,
  sessionProjects,
  dataDir,
  vendorOAuth,
  modelsDevCatalog,
  getWorkspacePath: currentWorkspacePath,
  pluginActiveInProject,
  bindingForModel,
  effectiveSubagentModelConfig,
  normalizeThinkingLevel,
});
sessionLaunchRuntime = createdSessionLaunchRuntime;
const {
  refreshUserMcp,
  activeUserSkills,
  activeUserSubagentDocuments,
  disabledBuiltinSubagents,
  loadUserSkillBody,
  resolveEffectiveCommandShell,
  resolveAgentRuntimeLaunch,
} = createdSessionLaunchRuntime;

/**
 * Refresh the cached plugin scopes from a `plugins.list` payload.
 *
 * Anything that changes a scope goes through host-core, so every read of the
 * list is also the moment to re-learn them.
 */
function rememberPluginScopes(list: Array<{ id?: string; scope?: ActivationScope }>): void {
  pluginScopes.clear();
  for (const plugin of list) {
    if (typeof plugin?.id === "string" && plugin.scope) {
      pluginScopes.set(plugin.id, plugin.scope);
    }
  }
}

/**
 * Whether a loaded plugin's contributions apply to `projectPath`.
 *
 * `enabled` is already implied — a disabled plugin is never loaded into the
 * runtime — so only the scope is consulted here. A plugin with no cached scope
 * counts as global, which is what every plugin installed before scopes existed
 * was.
 */
function pluginActiveInProject(pluginId: string, projectPath: string | null | undefined): boolean {
  const scope = pluginScopes.get(pluginId);
  if (!scope) return true;
  return isActiveInProject({ enabled: true, scope }, projectPath);
}

/**
 * The workspace the window is showing, from the cache Main keeps in sync with
 * every `workspace.get` / open-folder result. Synchronous on purpose: scope
 * filtering runs inside IPC handlers that must not await the host.
 */
function currentWorkspacePath(): string | null {
  return (globalThis as { __piWorkspacePath?: string | null }).__piWorkspacePath ?? null;
}

/** Push a panel event to detached windows and docked views. */
function broadcastPluginPanelEvent(event: string, payload: unknown): void {
  pluginPanels.broadcast(event, payload);
  pluginViews.broadcast(event, payload);
}

function setCurrentWorkspacePath(path: string | null): void {
  const previous = currentWorkspacePath();
  (globalThis as { __piWorkspacePath?: string | null }).__piWorkspacePath = path;
  if (previous === path) return;
  const payload = pluginWorkspaceInfo(path);
  broadcastPluginPanelEvent("workspace:changed", payload);
  plugins.broadcastEvent("workspace:changed", [payload]);
  // The group snapshot starts cold, so this first push can only carry the bare
  // workspace. Fetch the project's folders once and repeat it, so a plugin that
  // was already open sees them without waiting for the next switch; every later
  // switch finds the snapshot warm and broadcasts exactly once (ADR 0263).
  if (knownProjectGroups() === null) {
    void refreshProjectGroups(mainState.host).then((changed) => {
      if (!changed) return;
      const enriched = pluginWorkspaceInfo(currentWorkspacePath());
      broadcastPluginPanelEvent("workspace:changed", enriched);
      plugins.broadcastEvent("workspace:changed", [enriched]);
    });
  }
}

/** Pull the user's MCP server records from host-core into the local runtime. */
function sendToRenderer(channel: string, payload: unknown) {
  applicationLifecycle?.traySessions.observeEvent(channel, payload);
  applicationLifecycle?.taskbarUnreadBadge.observeEvent(channel, payload);
  if (channel === IPC.event.pluginChanged) {
    applicationLifecycle?.applyNativeThemeSource({
      theme: applicationAppearanceState.appThemePreference,
    });
  }
  if (!IPC_WHITELIST.has(channel)) return;
  const window = mainState.mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return;
  }
  try {
    window.webContents.send(channel, payload);
  } catch {
    // The renderer's main frame can be disposed — the window closed while the
    // app keeps running (macOS dock, resident tray) or a teardown race where
    // webContents.isDestroyed() has not flipped yet — before the send reaches
    // it. Notifying a gone frame is routine teardown, never an error:
    // supervision must keep running with no window attached.
  }

}

installInsecureEndpointNotice(sendToRenderer);

applicationLifecycle = createApplicationLifecycle({
  getRunningSessionIds: () => activeTurns.keys(),
  state: windowLifecycleState,
  appState: applicationLifecycleState,
  appearanceState: applicationAppearanceState,
  dataDir,
  isDevelopmentBuild,
  windowsAllowedToClose,
  windowMinWidth: WINDOW_MIN_WIDTH,
  windowMinHeight: WINDOW_MIN_HEIGHT,
  windowBoundsSettleMs: WINDOW_BOUNDS_SETTLE_MS,
  workPanelNativeResizeSettleMs: WORK_PANEL_NATIVE_RESIZE_SETTLE_MS,
  applyWorkPanelReservation,
  markWorkPanelChatResizeActive,
  workPanelMinimumWindowWidth,
  observedWorkPanelBaseBounds,
  classifyDisplayTransition,
  sendToRenderer,
  safeOpenExternal,
  showPluginLauncher: showPluginLauncherForLifecycle,
  askCloseBehavior: askCloseBehaviorForLifecycle,
  applyCloseBehavior: applyCloseBehaviorForLifecycle,
  browserPane,
  pluginViews,
  plugins,
  logger,
  refreshReleaseNotes: () => updater.refreshReleaseNotes(),
  applyPluginLauncherShortcut: applyPluginLauncherShortcutForLifecycle,
  applyToggleWindowShortcut: applyToggleWindowShortcutForLifecycle,
  broadcastPluginPanelEvent,
  getHost,
});
const {
  applyDevelopmentBranding,
  hasVisibleWindow,
  restoreMainWindow,
  toggleMainWindow,
  updateTrayMenu,
  createTray,
  resetMenuRendererReady,
  markMenuRendererReady,
  waitForMenuRenderer,
  ensureWindow,
  deliverApplicationMenuCommand,
  dispatchApplicationMenuCommand,
  executeNativeMenuAction,
  dispatchNativeMenuAction,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  disposePowerSaveBlockers,
  applyNativeThemeSource,
  applyApplicationMenuSettings,
  applyAppThemePreference,
  resolveAppearance,
  broadcastAppearance,
  flushPendingApplicationMenuCommands,
} = applicationLifecycle;

wirePluginThemeRuntimeServices({
  plugins,
  getHost,
  sendToRenderer,
  applyAppThemePreference,
  broadcastAppearance,
});

closeBehaviorRuntime = createCloseBehaviorRuntime({
  state: windowLifecycleState,
  dataDir,
  getLocale: () => mainState.updaterLocale,
  createTray,
});
const {
  applyCloseBehavior,
  askCloseBehavior,
  confirmQuitDialog,
} = closeBehaviorRuntime;

const createdLauncher = createLauncher({
  state: windowLifecycleState,
  launcherState,
  appState: applicationLifecycleState,
  getHost,
  logger,
  safeOpenExternal,
  toggleMainWindow,
});
launcherRuntime = createdLauncher;
const {
  prewarmPluginLauncher,
  showPluginLauncher,
  togglePluginLauncher,
  applyPluginLauncherShortcut,
  applyToggleWindowShortcut,
} = createdLauncher;

/** sessionId → open host turn id, for turn bookkeeping across agent events. */
const activeTurns = new Map<string, string>();
/** Plan submission turns end without a task-complete notification. */
const planSubmissionTurnIds = new Set<string>();
/** sessionId → host execution id for an approved plan currently dispatched. */
const approvedExecutionIdsBySession = new Map<string, string>();
/** executionId → durable execution turn identity. */
const approvedExecutionTurns = new Map<
  string,
  { sessionId: string; turnId: string }
>();
/** Claimed executions remain tracked even before their durable turn exists. */
const claimedExecutionSessions = new Map<string, string>();
/** Click/start deduplication for approved plan execution. */
const dispatchingApprovedExecutions = new Set<string>();
const startedApprovedExecutions = new Set<string>();
const finishedApprovedExecutions = new Set<string>();
const pendingExecutionFinishes = new Map<
  string,
  { status: PlanExecutionFinishStatus; errorCode?: string }
>();
const inFlightExecutionFinishes = new Set<string>();
/** sessionId → scheduled task_run id awaiting completion. */
const scheduledRunsBySession = new Map<string, string>();
/** Preserve tool metadata until the result is persisted at tool_end. Subagent
 * calls also carry their attribution, which is what lets a permission request
 * name the delegate that asked (ADR 0062). */
const activeToolCalls = new Map<
  string,
  {
    toolName: string;
    args: unknown;
    createdAt: string;
    turnId?: string;
    parentToolCallId?: string;
    agentName?: string;
  }
>();

const sessionCoordination = createSessionCoordination({
  activeTurns,
  getMainWindow,
  getViewingSessionId: () => mainState.notificationViewingSessionId,
});
const {
  turnSettlements,
  activeTurnUsages,
  acquireSessionOperation,
  addActiveTurnUsage,
  activeToolCallKey,
  planSubmissionTurnKey,
  waitForTurnSettlement,
  shouldCreateTaskNotification,
  lockAbortReason,
  isTurnDispatchable,
  isSessionBusy,
  isStaleTerminalEvent,
} = sessionCoordination;

/**
 * Applies a close-behavior choice. The tray icon is owned by D216 and stays
 * resident on every platform, so switching to "quit" must not destroy it —
 * minimize-to-tray still needs it to bring the window back.
 */
let runtimeLifecycle: ReturnType<typeof createRuntimeLifecycle> | null = null;
const superviseRestart = (kind: "host" | "sidecar"): Promise<void> => {
  if (!runtimeLifecycle) {
    return Promise.reject(new Error("runtime lifecycle is not initialized"));
  }
  return runtimeLifecycle.superviseRestart(kind);
};

const planUiProbe = createPlanUiProbe({
  getHost,
  getSidecar,
  logger,
});

let emitAgentEvent: (envelope: AgentEventEnvelope) => void = () => undefined;

const sessionCollaboration = createSessionCollaborationService({
  getHost,
  getSidecar,
  getBridge: () => mainState.agentHostBridge,
  getActiveTurn: (sessionId) => activeTurns.get(sessionId),
  flushTranscript: async () => {
    await persistenceOutbox.flush(getHost);
    return persistenceOutbox.size() === 0;
  },
  isPluginLoaded: (pluginId) => plugins.listLoaded().some((plugin) => plugin.manifest.id === pluginId),
  isQuitting: () => mainState.quitting,
  onChanged: () => sendToRenderer(IPC.event.sessionsChanged, { reason: "session.collaboration" }),
  log: (message, data) => logger.app("runtime", "warn", message, { data }),
});

const planRuntime = createPlanRuntime({
  runtimeState,
  planState: planRuntimeState,
  logger,
  sendToRenderer,
  coordination: sessionCoordination,
  scheduledRunsBySession,
  activeToolCalls,
  planSubmissionTurnIds,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  approvedExecutionTurns,
  startedApprovedExecutions,
  finishedApprovedExecutions,
  dispatchingApprovedExecutions,
  inFlightExecutionFinishes,
  pendingExecutionFinishes,
  announceTurnEnded,
  emitAgentEvent: (envelope) => emitAgentEvent(envelope),
  acquireSessionOperation,
  resolveAgentRuntimeLaunch,
  isQuitting: () => mainState.quitting,
  onTurnSettled: sessionCollaboration.settle,
});
const {
  finishTurn,
  finishApprovedExecution,
  dispatchApprovedPlan,
  drainApprovedPlanExecutions,
  dispatchExecutionForProposal,
} = planRuntime;

const eventPersistence = createEventPersistence({
  runtimeState,
  steeringReplies,
  activeTurns,
  activeToolCalls,
  activeToolCallKey,
  approvedExecutionIdsBySession,
  approvedExecutionTurns,
  pendingExecutionFinishes,
  planSubmissionTurnIds,
  planSubmissionTurnKey,
  inflightCheckpointer,
  persistenceOutbox,
  addActiveTurnUsage,
  logger,
  finishTurn,
  isStaleTerminalEvent,
  finishApprovedExecution,
  emitAgentEvent: (envelope) => emitAgentEvent(envelope),
});
const { persistAgentEvent } = eventPersistence;

const sidecarRuntime = createSidecarRuntime({
  runtimeState,
  steeringReplies,
  logger,
  sendToRenderer,
  persistAgentEvent,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  inflightCheckpointer,
  finishTurn,
  isStaleTerminalEvent,
  finishApprovedExecution,
  superviseRestart,
  isQuitting: () => mainState.quitting,
  dataDir,
  agentExtensions,
  vendorOAuth,
  listRuntimeProviders,
  modelsDevCatalog,
  effectiveSubagentModelConfig,
  browserHost,
  plugins,
  sessionProjects,
  loadUserSkillBody,
  activeUserSkills,
  pluginActiveInProject,
  currentNetworkProxy,
});
emitAgentEvent = sidecarRuntime.emitAgentEvent;
const { wireSidecar, startSidecar } = sidecarRuntime;

const { wireHost, startHost } = createHostRuntime({
  runtimeState,
  dataDir,
  logger,
  persistenceOutbox,
  activeToolCalls,
  activeToolCallKey,
  sessionProjects,
  plugins,
  userMcp,
  pluginActiveInProject,
  sendToRenderer,
  emitAgentEvent,
  togglePluginLauncher,
  finishTurn,
  isTurnDispatchable,
  finishApprovedExecution,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  importLegacyScheduled,
  superviseRestart,
  isQuitting: () => mainState.quitting,
});

runtimeLifecycle = createRuntimeLifecycle({
  runtimeState,
  dataDir,
  logger,
  sendToRenderer,
  startHost,
  startSidecar,
  drainApprovedPlanExecutions,
  applyNetworkProxyFromAppSettings,
  plugins,
  setCurrentWorkspacePath,
  rememberPluginScopes,
  refreshUserMcp,
  isQuitting: () => mainState.quitting,
  getDisplayLocale: () => applicationAppearanceState.updaterLocale,
});
const { bootHostStatus, runtimeArch, bootBackends } = runtimeLifecycle;

const voiceService = createVoiceService(dataDir + "/voice-models", getMainWindow);

function registerIpc() {
  return registerIpcHandlers({
    traySessions: applicationLifecycle!.traySessions,
    taskbarUnreadBadge: applicationLifecycle!.taskbarUnreadBadge,
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge: () => mainState.agentHostBridge,
    getBackendRouter: () => startupState.backendRouter,
    getNotificationViewingSessionId: () => mainState.notificationViewingSessionId,
    setNotificationViewingSessionId: (sessionId: string | null) => {
      mainState.notificationViewingSessionId = sessionId;
    },
    getPluginLauncherWindow: () => mainState.pluginLauncherWindow,
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
    pluginActiveInProject,
    getWorkPanelReservationWidth: () => mainState.requestedWorkPanelReservation,
    setWorkPanelReservationWidth: (width: number) => {
      mainState.requestedWorkPanelReservation = width;
    },
    setWorkPanelReservation: (state: WorkPanelReservationState) => {
      mainState.workPanelReservation = state;
    },
    getWorkPanelChatWidthSetter: () => mainState.setWorkPanelChatWidthForWindow,
    applyCloseBehavior,
    getCloseBehavior: () => mainState.closeBehavior,
    markMenuRendererReady,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isQuitting: () => mainState.quitting,
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
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale: () => mainState.updaterLocale,
    getPluginPanelTheme: () => mainState.pluginPanelTheme,
    isDeveloperMode: () => mainState.developerMode,
    sendToRenderer,
    voiceService,
  });
}

// Default hardening for every web contents Electron creates, applied before
// the owning surface can wire its own handlers (which replace these). A new
// window that forgets to set a window-open handler therefore denies popups
// and cannot attach a <webview> instead of inheriting Chromium's defaults.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
});

registerApplicationStartup({
  hasSingleInstanceLock,
  state: startupState,
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
  invokeSessionCollaboration: sessionCollaboration.invoke,
  onSessionQueueChange: () => {
    void sessionCollaboration.drain().catch((error: unknown) => {
      logger.app("runtime", "warn", "session callback drain failed", { data: String(error) });
    });
  },
});

registerShutdownHandlers({
  hasSingleInstanceLock,
  state: shutdownState,
  getHost,
  getSidecar,
  getMcpControl: () => mainState.mcpControl,
  activeTurns,
  persistenceOutbox,
  inflightCheckpointer,
  pluginPanels,
  plugins,
  userMcp,
  mcpOAuth,
  browserPane,
  pluginViews,
  updater,
  logger,
  confirmQuitDialog,
  disposePowerSaveBlockers,
});

registerApplicationActivation({
  restoreMainWindow,
  isQuitting: () => mainState.quitting,
  isApplicationBooted: () => applicationLifecycleState.applicationBooted,
  hasVisibleWindow,
});
