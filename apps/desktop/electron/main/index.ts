import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  Tray,
} from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  testNetworkProxy,
} from "./network-proxy";
import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  ErrorCodes as SharedErrorCodes,
  IPC,
  IPC_WHITELIST,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  err,
  isActiveInProject,
  ok,
  type ActivationScope,
  type AgentEventEnvelope,
  type AppMenuCommand,
  type CloseBehavior,
  type KeybindingOverrides,
  type Result,
  type PlanExecutionFinishStatus,
} from "@pi-desktop/shared";
import {
  genericModelConfig,
  summarizeSessionTitle,
} from "@pi-desktop/agent-runtime";
import { AgentExtensionBridge } from "./agent-extensions";
import { registerAgentExtensionIpc } from "./agent-extensions-ipc";
import { isTemplateName, scaffold } from "@pi-desktop/plugin-devkit";

import { HostProcess } from "./host-process";
import {
  shouldCreateTaskNotification as shouldCreateTaskNotificationPolicy,
  shouldShowNativeNotification,
} from "./notification-policy";
import { PersistenceOutbox } from "./persistence-outbox";
import { InflightCheckpointer } from "./inflight-checkpoint";
import { AgentSidecar } from "./agent-sidecar";
import { Logger, ignoreBrokenStdio } from "./logger";
import {
  isDbSchemaTooNewError,
} from "./host-boot-diagnostics";
import {
  ModelsDevCatalog,
  modelConfigFromModelsDev,
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
  executionFromResponse,
  executionListFromResponse,
  planExecutionFromUnknown,
} from "./plan-execution";
import {
  readWindowState,
  writeWindowState,
} from "./window-preferences";
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
import { registerScheduledIpc } from "./ipc/scheduled-ipc";
import { registerAgentIpc } from "./ipc/agent-ipc";
import { registerIpcHandlers } from "./ipc/register";
import {
  type WindowLifecycleState,
} from "./bootstrap/window";
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

// The shared error-code union is reconciled in the shared lane. Keep desktop
// source type-safe while that lane is temporarily staged at main.
const ErrorCodes = {
  ...SharedErrorCodes,
  COMMAND_SHELL_INVALID: "COMMAND_SHELL_INVALID",
  SHELL_NOT_FOUND: "SHELL_NOT_FOUND",
  PLAN_EXECUTION_INTERRUPTED: "PLAN_EXECUTION_INTERRUPTED",
  PLAN_PERMISSION_MODE_REQUIRED: "PLAN_PERMISSION_MODE_REQUIRED",
} as const;

/**
 * Strip the Windows extended-length path prefix (`\\?\`) so that shell APIs
 * like `ShellExecuteW` (used by Electron's `shell.openPath`) work correctly.
 * Also handles the forward-slash variant (`//?/`) stored by older versions.
 * On non-Windows or for UNC paths (`\\?\UNC\...`) the input is returned as-is.
 */
function stripWinLongPrefix(p: string): string {
  if (process.platform !== "win32") return p;
  // Matches `\\?\X:\...` (verbatim drive-letter paths)
  if (p.startsWith("\\\\?\\") && p.length >= 7 && p[5] === ":" && p[6] === "\\") {
    return p.slice(4);
  }
  // Matches `//?/X:/...` (forward-slash variant from DB normalization)
  if (p.startsWith("//?/") && p.length >= 7 && p[5] === ":" && p[6] === "/") {
    return p.slice(4);
  }
  return p;
}

// A closed stdout/stderr (Linux AppImage, GUI launch without a TTY) must not
// surface as Electron's "Uncaught Exception: write EPIPE" dialog.
ignoreBrokenStdio();

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

// One data directory admits exactly one desktop process. host-core owns
// `pi.sqlite` exclusively (D002), Electron main owns the persistence outbox and
// the log tree beside it, and the tray, the global launcher shortcut, and the
// updater are singletons of the running app — a second process fights the first
// for every one of them and leaves the user with two shells over one database.
//
// Electron keeps the lock in `userData`, which is derived from the app name set
// just above, so it is taken after `setName` and before anything else in this
// module touches the data directory. That scope is the installation, not
// `PI_DESKTOP_DATA_DIR`: a run pointed at its own data directory (E2E
// harnesses, the capture rig, a side-by-side profile) shares no state with the
// default installation and stays launchable while one is running.
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pluginLauncherWindow: BrowserWindow | null = null;
let pluginLauncherCreationPromise: Promise<BrowserWindow> | null = null;
let pluginLauncherAccelerator: string | null = null;
let pluginLauncherBinding: string | null = null;
let summonWindowAccelerator: string | null = null;
const launcherState: LauncherState = {
  get creationPromise() {
    return pluginLauncherCreationPromise;
  },
  set creationPromise(value) {
    pluginLauncherCreationPromise = value;
  },
  get pluginLauncherAccelerator() {
    return pluginLauncherAccelerator;
  },
  set pluginLauncherAccelerator(value) {
    pluginLauncherAccelerator = value;
  },
  get summonWindowAccelerator() {
    return summonWindowAccelerator;
  },
  set summonWindowAccelerator(value) {
    summonWindowAccelerator = value;
  },
};
let windowCreationPromise: Promise<void> | null = null;
let applicationBooted = false;
const isDevelopmentBuild =
  process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
const pendingApplicationMenuCommands: AppMenuCommand[] = [];
type MenuRendererReadyGate = {
  window: BrowserWindow;
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
};
let menuRendererReadyGate: MenuRendererReadyGate | null = null;
let requestedWorkPanelReservation = 0;
let workPanelReservation = emptyWorkPanelReservationState();
let workPanelDisplayKey: string | null = null;
// Base bounds are persistable; last-applied bounds isolate later native deltas.
let workPanelBaseBounds: WindowBounds | null = null;
let workPanelLastAppliedBounds: WindowBounds | null = null;
// A reservation changes native bounds intentionally. The next matching move
// event belongs to that mutation, not to a user dragging the window between
// displays.
let expectedWorkPanelBounds: WindowBounds | null = null;
// Set while a native `move` stream is unaccounted for, which is what separates
// a display change the user caused by dragging from one the OS imposed on
// bounds we asked for (D263). A flag rather than a deadline: attribution must
// not depend on how long the main process took to reach the classification.
let workPanelUserMovePending = false;
let workPanelNativeResizeActive = false;
let workPanelChatResizeActive = false;
let workPanelChatResizeTimer: NodeJS.Timeout | null = null;
let setWorkPanelChatWidthForWindow: ((width: number) => number) | null = null;
let host: HostProcess | null = null;
let sidecar: AgentSidecar | null = null;
let mcpControl: McpControlServer | null = null;
let agentHostBridge: AgentHostBridge | null = null;
let desktopControl: McpControlController | null = null;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
// User-chosen close behavior on Windows/Linux; "ask" prompts on first close.
// The tray itself is owned by D216 (always present on every platform), so
// close behavior only decides whether a close hides the window to it.
let closeBehavior: CloseBehavior = "ask";
let closePromptOpen = false;
// Set when the user has explicitly confirmed a quit through the confirmation
// dialog (Cmd+Q, tray quit, etc.). Prevents the dialog from showing again when
// `app.quit()` is re-issued after the user confirmed.
let quitConfirmed = false;
// Windows whose close handler has already decided to let the close through.
// Per-window rather than a module-level latch, so a real close never leaks
// permission to close into the next window `ensureWindow()` creates.
const windowsAllowedToClose = new WeakSet<BrowserWindow>();

// The window bootstrap owns this mutable boundary. Accessors keep the
// existing lifecycle state available to the remaining main-process services
// while preventing the bootstrap module from reaching into their globals.
const windowLifecycleState: WindowLifecycleState = {
  get mainWindow() {
    return mainWindow;
  },
  set mainWindow(value) {
    mainWindow = value;
  },
  get notificationViewingSessionId() {
    return notificationViewingSessionId;
  },
  set notificationViewingSessionId(value) {
    notificationViewingSessionId = value;
  },
  get requestedWorkPanelReservation() {
    return requestedWorkPanelReservation;
  },
  set requestedWorkPanelReservation(value) {
    requestedWorkPanelReservation = value;
  },
  get workPanelReservation() {
    return workPanelReservation;
  },
  set workPanelReservation(value) {
    workPanelReservation = value;
  },
  get workPanelDisplayKey() {
    return workPanelDisplayKey;
  },
  set workPanelDisplayKey(value) {
    workPanelDisplayKey = value;
  },
  get workPanelBaseBounds() {
    return workPanelBaseBounds;
  },
  set workPanelBaseBounds(value) {
    workPanelBaseBounds = value;
  },
  get workPanelLastAppliedBounds() {
    return workPanelLastAppliedBounds;
  },
  set workPanelLastAppliedBounds(value) {
    workPanelLastAppliedBounds = value;
  },
  get expectedWorkPanelBounds() {
    return expectedWorkPanelBounds;
  },
  set expectedWorkPanelBounds(value) {
    expectedWorkPanelBounds = value;
  },
  get workPanelUserMovePending() {
    return workPanelUserMovePending;
  },
  set workPanelUserMovePending(value) {
    workPanelUserMovePending = value;
  },
  get workPanelNativeResizeActive() {
    return workPanelNativeResizeActive;
  },
  set workPanelNativeResizeActive(value) {
    workPanelNativeResizeActive = value;
  },
  get workPanelChatResizeTimer() {
    return workPanelChatResizeTimer;
  },
  set workPanelChatResizeTimer(value) {
    workPanelChatResizeTimer = value;
  },
  get workPanelChatResizeActive() {
    return workPanelChatResizeActive;
  },
  set workPanelChatResizeActive(value) {
    workPanelChatResizeActive = value;
  },
  get setWorkPanelChatWidthForWindow() {
    return setWorkPanelChatWidthForWindow;
  },
  set setWorkPanelChatWidthForWindow(value) {
    setWorkPanelChatWidthForWindow = value;
  },
  get pluginLauncherBinding() {
    return pluginLauncherBinding;
  },
  set pluginLauncherBinding(value) {
    pluginLauncherBinding = value;
  },
  get closePromptOpen() {
    return closePromptOpen;
  },
  set closePromptOpen(value) {
    closePromptOpen = value;
  },
  get quitConfirmed() {
    return quitConfirmed;
  },
  set quitConfirmed(value) {
    quitConfirmed = value;
  },
  get menuRendererReadyGate() {
    return menuRendererReadyGate;
  },
  set menuRendererReadyGate(value) {
    menuRendererReadyGate = value;
  },
  get quitting() {
    return quitting;
  },
  set quitting(value) {
    quitting = value;
  },
  get tray() {
    return tray;
  },
  set tray(value) {
    tray = value;
  },
  get closeBehavior() {
    return closeBehavior;
  },
  set closeBehavior(value) {
    closeBehavior = value;
  },
  get developerMode() {
    return developerMode;
  },
  set developerMode(value) {
    developerMode = value;
  },
  get pluginLauncherWindow() {
    return pluginLauncherWindow;
  },
  set pluginLauncherWindow(value) {
    pluginLauncherWindow = value;
  },
  get host() {
    return host;
  },
  set host(value) {
    host = value;
  },
};

const runtimeState: RuntimeState = {
  get host() {
    return host;
  },
  set host(value) {
    host = value;
  },
  get sidecar() {
    return sidecar;
  },
  set sidecar(value) {
    sidecar = value;
  },
  get agentHostBridge() {
    return agentHostBridge;
  },
  set agentHostBridge(value) {
    agentHostBridge = value;
  },
};

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
const applySummonWindowShortcutForLifecycle = (
  keybindings?: KeybindingOverrides,
) => {
  launcherRuntime?.applySummonWindowShortcut(keybindings);
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
  getMainWindow: () => mainWindow,
});
const {
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  recordPastedClipboardFiles,
  safeOpenExternal,
} = desktopServices;

const dataDir =
  process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop");

// Agent extensions (D387/D388, ADR 0214): plugins contribute the modules,
// the sidecar loads them; this bridge carries commands, diagnostics, and
// prompts between the two.
const agentExtensions = new AgentExtensionBridge({
  hasRenderer: () =>
    !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed(),
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
  process.env.NODE_ENV === "production" ? "info" : "debug",
);
const persistenceOutbox = new PersistenceOutbox(dataDir, (level, message, data) => {
  logger.app("persistence", level, message, { data });
});
const scheduledRuntime = createScheduledRuntime({
  dataDir,
  getHost: () => host,
  logger,
});
const { importLegacyScheduled } = scheduledRuntime;
// The reply currently streaming in each session, checkpointed to host-core so
// a quit or crash mid-reply keeps the text the user already saw (D299). A
// checkpoint is a best-effort write against a live host; the outbox is not
// involved because a stale checkpoint must never be replayed after the final
// row.
const inflightCheckpointer = new InflightCheckpointer(async (checkpoint) => {
  if (!host || !host.isAvailable()) return;
  await host.call(
    "session.saveInflightMessage",
    {
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      message: checkpoint.message,
    },
    5_000,
  );
});

/** Product UI locale for shipped-locale update notes (mirrored from settings). */
let updaterLocale = "en";
type PluginPanelTheme = "light" | "dark";
let pluginPanelTheme: PluginPanelTheme = nativeTheme.shouldUseDarkColors
  ? "dark"
  : "light";
/** Raw theme preference from AppSettings.theme, surfaced by `app.getAppearance`. */
let appThemePreference: string = "system";
/** Last appearance broadcast to plugin panels; avoids redundant pushes. */
let broadcastAppearanceSignature = "";

const updater = new AppUpdaterController({
  logger,
  send: sendToRenderer,
  currentVersion: APP_VERSION,
  isPackaged: !isDevelopmentBuild,
  getLocale: () => updaterLocale,
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
    if (!host) throw new Error("host unavailable");
    return host.call<T>(method, params);
  },
  emit: (event) => sendToRenderer(IPC.event.providersOauth, event),
  openExternal: async (url) => {
    await safeOpenExternal(url);
  },
  log: (level, message, data) => logger.app("provider", level, message, { data }),
  modelConfigFor: async ({ vendorKey, option }) => {
    await modelsDevCatalog.ensureLoaded();
    const model = modelsDevCatalog.findModel({
      vendorKey,
      baseUrl: option.baseUrl,
      modelId: option.modelId,
    });
    return model
      ? modelConfigFromModelsDev(model, option.baseUrl)
      : genericModelConfig(option.modelId, option.baseUrl);
  },
});

let sessionLaunchRuntime: ReturnType<typeof createSessionLaunchRuntime> | null = null;
const pluginServices = createPluginServices({
  dataDir,
  logger,
  getMainWindow: () => mainWindow,
  getHost: () => host,
  sendToRenderer,
  safeOpenExternal,
  stripWinLongPrefix,
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  getUpdaterLocale: () => updaterLocale,
  getPluginPanelTheme: () => pluginPanelTheme,
  getAppearance: () => {
    if (!applicationLifecycle) {
      throw new Error("application lifecycle is not initialized");
    }
    return applicationLifecycle.resolveAppearance();
  },
  getWorkspacePath: currentWorkspacePath,
  isHostUnavailable,
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
  pluginScopes,
  sessionProjects,
  emitBrowserState,
  pluginPanels,
  pluginViews,
  browserHost,
  browserPane,
} = pluginServices;

const providerCatalogRuntime = createProviderCatalogRuntime({
  getHost: () => host,
  modelsDevCatalog,
});
const {
  bindingForModel,
  modelsDevModelFor,
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
  modelsDevModelFor,
  effectiveSubagentModelConfig,
  normalizeThinkingLevel,
});
sessionLaunchRuntime = createdSessionLaunchRuntime;
const {
  refreshUserMcp,
  activeUserSkills,
  activeUserSubagentDocuments,
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

function workspaceInfo(
  path: string | null,
): { path: string; name: string } | null {
  if (!path) return null;
  return { path, name: path.split(/[\\/]/).filter(Boolean).at(-1) || path };
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
  const payload = workspaceInfo(path);
  broadcastPluginPanelEvent("workspace:changed", payload);
  plugins.broadcastEvent("workspace:changed", [payload]);
}

/** One-line message for an error of unknown shape, for user-facing lists. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}

/**
 * True when a rejection only says the host transport is gone (D080): the call
 * lost a race with shutdown, a crash, or a supervised restart. Every such
 * rejection carries `HOST_UNAVAILABLE`, whether it was refused before it was
 * sent or was in flight when the transport closed.
 */
function isHostUnavailable(error: unknown): boolean {
  return (
    (error as { errorCode?: string } | null | undefined)?.errorCode ===
    ErrorCodes.HOST_UNAVAILABLE
  );
}

/** Pull the user's MCP server records from host-core into the local runtime. */
function sendToRenderer(channel: string, payload: unknown) {
  if (channel === IPC.event.pluginChanged) {
    applicationLifecycle?.applyNativeThemeSource({
      theme: applicationAppearanceState.appThemePreference,
    });
  }
  if (!IPC_WHITELIST.has(channel)) return;
  const window = mainWindow;
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

let appliedMenuSettings: string | null = null;

/**
 * Devtools stay locked until the user opts in via settings (D-dev mode);
 * mirrors `AppSettings.developerMode` so the IPC handler, the F12 shortcut
 * and the macOS View menu all read one flag.
 */
let developerMode = false;

const applicationLifecycleState: ApplicationLifecycleState = {
  get windowCreationPromise() {
    return windowCreationPromise;
  },
  set windowCreationPromise(value) {
    windowCreationPromise = value;
  },
  get applicationBooted() {
    return applicationBooted;
  },
  set applicationBooted(value) {
    applicationBooted = value;
  },
  pendingApplicationMenuCommands,
  get appliedMenuSettings() {
    return appliedMenuSettings;
  },
  set appliedMenuSettings(value) {
    appliedMenuSettings = value;
  },
};

const applicationAppearanceState: ApplicationAppearanceState = {
  get updaterLocale() {
    return updaterLocale;
  },
  set updaterLocale(value) {
    updaterLocale = value;
  },
  get pluginPanelTheme() {
    return pluginPanelTheme;
  },
  set pluginPanelTheme(value) {
    pluginPanelTheme = value;
  },
  get appThemePreference() {
    return appThemePreference;
  },
  set appThemePreference(value) {
    appThemePreference = value;
  },
  get broadcastAppearanceSignature() {
    return broadcastAppearanceSignature;
  },
  set broadcastAppearanceSignature(value) {
    broadcastAppearanceSignature = value;
  },
};

applicationLifecycle = createApplicationLifecycle({
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
  applySummonWindowShortcut: applySummonWindowShortcutForLifecycle,
  broadcastPluginPanelEvent,
});
const {
  applyDevelopmentBranding,
  hasVisibleWindow,
  restoreMainWindow,
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
  applyNativeThemeSource,
  applyApplicationMenuSettings,
  resolveAppearance,
  broadcastAppearance,
  flushPendingApplicationMenuCommands,
} = applicationLifecycle;

closeBehaviorRuntime = createCloseBehaviorRuntime({
  state: windowLifecycleState,
  dataDir,
  getLocale: () => updaterLocale,
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
  getHost: () => host,
  logger,
  safeOpenExternal,
  restoreMainWindow,
});
launcherRuntime = createdLauncher;
const {
  prewarmPluginLauncher,
  showPluginLauncher,
  togglePluginLauncher,
  applyPluginLauncherShortcut,
  applySummonWindowShortcut,
} = createdLauncher;

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
let approvedExecutionDrain: Promise<void> | null = null;
const planRuntimeState: PlanRuntimeState = {
  get approvedExecutionDrain() {
    return approvedExecutionDrain;
  },
  set approvedExecutionDrain(value) {
    approvedExecutionDrain = value;
  },
};
const turnFinalizations = new Map<string, Promise<void>>();

/** sessionId → scheduled task_run id awaiting completion. */
const scheduledRunsBySession = new Map<string, string>();
/** Session currently rendered on the chat page; focus remains Main-owned. */
let notificationViewingSessionId: string | null = null;
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
  getMainWindow: () => mainWindow,
  getViewingSessionId: () => notificationViewingSessionId,
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
} = sessionCoordination;

async function withGitBranch<T extends { path?: string; name?: string } | null | undefined>(
  workspace: T,
): Promise<T> {
  if (!workspace || !workspace.path) return workspace;
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const head = await readFile(join(workspace.path, ".git/HEAD"), "utf8");
    const match = head.match(/ref:\s*refs\/heads\/(.+)$/m);
    return {
      ...workspace,
      branch: match?.[1]?.trim() || "detached",
    };
  } catch {
    return { ...workspace, branch: undefined };
  }
}

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
  getHost: () => host,
  getSidecar: () => sidecar,
  logger,
});

let emitAgentEvent: (envelope: AgentEventEnvelope) => void = () => undefined;

const planRuntime = createPlanRuntime({
  runtimeState,
  planState: planRuntimeState,
  logger,
  sendToRenderer,
  activeTurns,
  activeTurnUsages,
  scheduledRunsBySession,
  activeToolCalls,
  turnFinalizations,
  turnSettlements,
  planSubmissionTurnIds,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  approvedExecutionTurns,
  startedApprovedExecutions,
  finishedApprovedExecutions,
  dispatchingApprovedExecutions,
  inFlightExecutionFinishes,
  pendingExecutionFinishes,
  waitForTurnSettlement,
  planSubmissionTurnKey,
  shouldCreateTaskNotification,
  emitAgentEvent: (envelope) => emitAgentEvent(envelope),
  acquireSessionOperation,
  resolveAgentRuntimeLaunch,
  isQuitting: () => quitting,
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
  finishApprovedExecution,
  emitAgentEvent: (envelope) => emitAgentEvent(envelope),
});
const { persistAgentEvent } = eventPersistence;

const sidecarRuntime = createSidecarRuntime({
  runtimeState,
  logger,
  sendToRenderer,
  persistAgentEvent,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  inflightCheckpointer,
  finishTurn,
  finishApprovedExecution,
  superviseRestart,
  isQuitting: () => quitting,
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
  finishApprovedExecution,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  importLegacyScheduled,
  superviseRestart,
  isQuitting: () => quitting,
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
  isQuitting: () => quitting,
});
const { bootHostStatus, runtimeArch, bootBackends } = runtimeLifecycle;

function registerIpc() {
  return registerIpcHandlers({
    ipcMain,
    wrap,
    getMainWindow: () => mainWindow,
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => agentHostBridge,
    getNotificationViewingSessionId: () => notificationViewingSessionId,
    setNotificationViewingSessionId: (sessionId: string | null) => {
      notificationViewingSessionId = sessionId;
    },
    getPluginLauncherWindow: () => pluginLauncherWindow,
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
    pluginActiveInProject,
    getWorkPanelReservationWidth: () => requestedWorkPanelReservation,
    setWorkPanelReservationWidth: (width: number) => {
      requestedWorkPanelReservation = width;
    },
    setWorkPanelReservation: (state: WorkPanelReservationState) => {
      workPanelReservation = state;
    },
    getWorkPanelChatWidthSetter: () => setWorkPanelChatWidthForWindow,
    applyCloseBehavior,
    getCloseBehavior: () => closeBehavior,
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
    activeUserSubagentDocuments,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale: () => updaterLocale,
    getPluginPanelTheme: () => pluginPanelTheme,
    isDeveloperMode: () => developerMode,
    sendToRenderer,
  });
}

// A rejected promise nobody awaited must land in the log with its stack, not
// in Electron's default handler. Main must keep running: the renderer, the
// host, and the sidecar are supervised separately and a stray rejection from
// one plugin bridge or IPC handler is not a reason to lose all of them.
process.on("unhandledRejection", (reason) => {
  logger.app("runtime", "error", "unhandled promise rejection in main", {
    data: reason instanceof Error ? `${reason.stack ?? reason.message}` : String(reason),
  });
});

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

const startupState: StartupState = {
  get applicationBooted() {
    return applicationLifecycleState.applicationBooted;
  },
  set applicationBooted(value) {
    applicationLifecycleState.applicationBooted = value;
  },
  get closeBehavior() {
    return closeBehavior;
  },
  set closeBehavior(value) {
    closeBehavior = value;
  },
  get agentHostBridge() {
    return agentHostBridge;
  },
  set agentHostBridge(value) {
    agentHostBridge = value;
  },
  get desktopControl() {
    return desktopControl;
  },
  set desktopControl(value) {
    desktopControl = value;
  },
  get mcpControl() {
    return mcpControl;
  },
  set mcpControl(value) {
    mcpControl = value;
  },
};

registerApplicationStartup({
  hasSingleInstanceLock,
  state: startupState,
  dataDir,
  logger,
  updater,
  modelsDevCatalog,
  plugins,
  activeTurns,
  turnFinalizations,
  getHost: () => host,
  getMainWindow: () => mainWindow,
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
});

const shutdownState: ShutdownState = {
  get shutdownComplete() {
    return shutdownComplete;
  },
  set shutdownComplete(value) {
    shutdownComplete = value;
  },
  get shutdownPromise() {
    return shutdownPromise;
  },
  set shutdownPromise(value) {
    shutdownPromise = value;
  },
  get quitting() {
    return quitting;
  },
  set quitting(value) {
    quitting = value;
  },
  get quitConfirmed() {
    return quitConfirmed;
  },
  set quitConfirmed(value) {
    quitConfirmed = value;
  },
  get closeBehavior() {
    return closeBehavior;
  },
  set closeBehavior(value) {
    closeBehavior = value;
  },
  get tray() {
    return tray;
  },
  set tray(value) {
    tray = value;
  },
  get pluginLauncherAccelerator() {
    return pluginLauncherAccelerator;
  },
  set pluginLauncherAccelerator(value) {
    pluginLauncherAccelerator = value;
  },
  get summonWindowAccelerator() {
    return summonWindowAccelerator;
  },
  set summonWindowAccelerator(value) {
    summonWindowAccelerator = value;
  },
};

registerShutdownHandlers({
  hasSingleInstanceLock,
  state: shutdownState,
  getHost: () => host,
  getSidecar: () => sidecar,
  getMcpControl: () => mcpControl,
  activeTurns,
  persistenceOutbox,
  inflightCheckpointer,
  pluginPanels,
  plugins,
  userMcp,
  browserPane,
  pluginViews,
  updater,
  logger,
  confirmQuitDialog,
});

app.on("activate", () => {
  restoreMainWindow();
});

// Launching PI-Desktop again is a request to see the app that is already
// running, not to start another one. The duplicate process quits before it
// boots anything, and Electron hands its launch to the lock holder here, so the
// visible result is the same as the tray's Show action — including a window
// that was closed or hidden into the tray, which `restoreMainWindow` recreates.
app.on("second-instance", () => {
  restoreMainWindow();
});

// macOS only emits `activate` from `applicationShouldHandleReopen:` — a Dock
// click or a relaunch. Cmd+Tab, App Exposé, and Spotlight activation do not
// reach it, and macOS traffic-light minimize hides the window into the tray
// (ADR 0078), so the app could be focused with nothing on screen and no way
// back except the tray.
// Restore only when no window is visible: activating the plugin launcher or a
// plugin panel must not drag the main window up with it (ADR 0086).
if (process.platform === "darwin") {
  app.on("did-become-active", () => {
    if (
      quitting ||
      !applicationLifecycleState.applicationBooted ||
      hasVisibleWindow()
    ) return;
    restoreMainWindow();
  });
}
