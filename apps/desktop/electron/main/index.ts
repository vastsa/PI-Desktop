import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification as SystemNotification,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { cloneGitRepository } from "./git-clone";
import {
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  testNetworkProxy,
} from "./network-proxy";
import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  APP_MENU_COMMANDS,
  defaultCommandShellForPlatform,
  ErrorCodes as SharedErrorCodes,
  IPC,
  IPC_WHITELIST,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  isCommandShellCatalog,
  isCommandShellId,
  isGlobalPermissionMode,
  NATIVE_MENU_ACTIONS,
  PROTOCOL_VERSION,
  THINKING_LEVELS,
  WINDOW_CONTROL_ACTIONS,
  err,
  isActiveInProject,
  modelIdsMatch,
  ok,
  parseMcpImport,
  type ActivationScope,
  type AgentCapabilityQuery,
  type ComposerPasteFile,
  type PluginViewMeta,
  type BrowserState,
  normalizeMode,
  type AgentEventEnvelope,
  type AgentPromptRequest,
  type PromptEnhancementRequest,
  type SessionSummarizeTitleRequest,
  type AgentStopRequest,
  type AskToolResolution,
  type AppMenuCommand,
  type AppNotification,
  type CloseBehavior,
  type CommandShellCatalog,
  type CommandShellId,
  type ComposerCommand,
  type GlobalPermissionMode,
  type KeybindingOverrides,
  type McpServerInput,
  type McpServerRecord,
  type McpServerStatus,
  type ModelBinding,
  type Mode,
  type NativeMenuAction,
  type OAuthRespondInput,
  type PlanExecution,
  type PlanExecutionFinishStatus,
  type PlanResolutionResult,
  type PlanResolveRequest,
  type Result,
  type Risk,
  type ShortcutPlatform,
  type ThinkingLevel,
  type UiMessage,
  type MessageUsage,
  addUsage,
  type UserSkillRecord,
  type UserSubagentRecord,
  type WindowControlAction,
  validateNetworkProxy,
  trustedExtensionCommandId,
  trustedExtensionCommandName,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  clampThinkingLevel,
  genericModelConfig,
  modelConfigWithBinding,
  visionFromModelConfig,
  expandSlashInvocation,
  enhancePromptDraft,
  summarizeSessionTitle,
  completeOneShot,
  loadComposerTemplates,
  loadInstructionChain,
  loadSubagentDefinitions,
  resolveSubagentProviders,
  mergeProviderHeaders,
  optionalProviderHeaders,
  type ComposerTemplate,
  type ThinkingCapabilities,
  type RuntimeProviderConfig,
  type UserSubagentDocument,
} from "@pi-desktop/agent-runtime";
import { AgentExtensionBridge } from "./agent-extensions";
import { registerAgentExtensionIpc } from "./agent-extensions-ipc";
import { isTemplateName, scaffold } from "@pi-desktop/plugin-devkit";
import type {
  PluginCompleteResult,
  PluginNativeNotificationInput,
  PluginNativeNotificationResult,
  PluginNotificationPermission,
} from "@pi-desktop/plugin-sdk";
import { resolvePluginLocalizedString } from "@pi-desktop/plugin-sdk";
import {
  asPluginThinkingLevel,
  listReadyPluginModels,
  parsePluginModelKey,
  pluginCompleteContext,
  pluginSessionContextFromSession,
} from "./plugin-agent-complete";

import { HostProcess } from "./host-process";
import {
  shouldCreateTaskNotification as shouldCreateTaskNotificationPolicy,
  shouldShowNativeNotification,
} from "./notification-policy";
import { PersistenceOutbox } from "./persistence-outbox";
import { InflightCheckpointer } from "./inflight-checkpoint";
import { AgentSidecar } from "./agent-sidecar";
import { PluginRuntime, resolveInsidePlugin as resolveInsidePluginRoot } from "./plugin-runtime";
import { ClipboardHistory } from "./clipboard-history";
import { createFsConsentService } from "./plugin-fs-consent";
import { createDesktopConsentService } from "./plugin-desktop-consent";
import { UserMcpRuntime } from "./user-mcp";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  McpServerClient,
} from "./plugin-mcp";
import { builtinSkills, loadBuiltinSkillBody } from "./builtin-skills";
import { registerPluginDevTools } from "./plugin-dev-tools";
import { PluginPanelHost } from "./plugin-panel-host";
import { PluginViewHost, pluginViewKey } from "./plugin-view-host";
import { parseAllowedExternalUrl } from "./safe-open-external";
import type { PluginAppearance } from "../shared/plugin-panel-chrome";
import { Logger, ignoreBrokenStdio } from "./logger";
import {
  isDbSchemaTooNewError,
} from "./host-boot-diagnostics";
import { collectWorkspaceDiff } from "./git-diff";
import { BrowserPane, resolveLocalFile } from "./browser-view";
import {
  BrowserHost,
  BROWSER_PLUGIN_ID,
  BROWSER_VIEW_ID,
} from "./browser-host";
import { discoverProviderModels } from "./model-discovery";
import {
  ModelsDevCatalog,
  modelConfigFromModelsDev,
  modelInfoFromModelsDev,
} from "./models-dev-catalog";
import { OAUTH_AUTH_KIND, VendorOAuth } from "./oauth";
import {
  isAttachmentBlobRef,
  listDir,
  readOpenableFile,
  readOpenableImage,
  resolveOpenablePath,
  resolveRealOpenablePath,
} from "./fs-panel";
import { getWorkspaceFileIndex } from "./fs-index";
import {
  importComposerFiles,
  saveComposerPasteFiles,
} from "./composer-paste";
import {
  consumeComposerPickerSelection,
  rememberComposerPickerSelection,
} from "./composer-picker";
import { builtinComposerCommands, builtinPaletteItems } from "./builtin-commands";
import { installApplicationMenu } from "./application-menu";
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
  readCloseBehavior,
  readWindowState,
  writeCloseBehavior,
  writeWindowState,
} from "./window-preferences";
import { createPlanUiProbe } from "./plan-ui-probe";
import {
  createMcpControlController,
  McpControlServer,
  mcpControlRendererEvent,
} from "./mcp-control";
import { createAgentHostBridge, type AgentHostBridge } from "./agent-host-bridge";
import type { AgentQueuePushRequest } from "@pi-desktop/shared";
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
  createWindow as createWindowInBootstrap,
  type WindowLifecycleState,
  type WindowMenuRendererReadyGate,
} from "./bootstrap/window";
import type { RuntimeState } from "./runtime/context";
import { createHostRuntime } from "./runtime/host";
import { createSidecarRuntime } from "./runtime/sidecar";
import { createEventPersistence } from "./runtime/event-persistence";
import { createPlanRuntime, type PlanRuntimeState } from "./runtime/plans";
import { createRuntimeLifecycle } from "./runtime/lifecycle";
import {
  createProviderCatalogRuntime,
  type RuntimeProvider,
} from "./runtime/provider-catalog";
import { registerDiagnosticsIpc } from "./ipc/diagnostics-ipc";
import { registerMarketIpc } from "./ipc/market-ipc";
import { registerMcpIpc } from "./ipc/mcp-ipc";
import { registerPluginIpc } from "./ipc/plugin-ipc";
import { registerPluginUiIpc } from "./ipc/plugin-ui-ipc";
import { registerSkillsIpc } from "./ipc/skills-ipc";
import type { IpcRegistrar } from "./ipc/types";

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
let desktopControl: ReturnType<typeof createMcpControlController> | null = null;
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

let pluginNotificationPermission: PluginNotificationPermission = "unknown";
const pluginNativeNotifications = new Set<SystemNotification>();
const PLUGIN_NOTIFICATION_TIMEOUT_MS = 2_000;

function getPluginNotificationPermission(): PluginNotificationPermission {
  if (!SystemNotification.isSupported()) return "unsupported";
  return pluginNotificationPermission;
}

function showPluginNativeNotification(
  input: PluginNativeNotificationInput,
): Promise<PluginNativeNotificationResult> {
  if (!SystemNotification.isSupported()) {
    return Promise.resolve({ shown: false, permission: "unsupported" });
  }

  const title = String(input.title ?? "Plugin").trim().slice(0, 100) || "Plugin";
  const body = String(input.body ?? "").trim().slice(0, 240);

  return new Promise((resolve) => {
    const notification = new SystemNotification({ title, body });
    pluginNativeNotifications.add(notification);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (permission: PluginNotificationPermission, shown: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (permission === "granted" || permission === "denied") {
        pluginNotificationPermission = permission;
      }
      if (!shown) pluginNativeNotifications.delete(notification);
      resolve({ shown, permission });
    };

    notification.once("show", () => finish("granted", true));
    notification.once("close", () => pluginNativeNotifications.delete(notification));
    (notification as unknown as {
      once: (event: string, listener: (...args: unknown[]) => void) => unknown;
    }).once("failed", () => finish("denied", false));

    timer = setTimeout(() => {
      finish(getPluginNotificationPermission(), false);
    }, PLUGIN_NOTIFICATION_TIMEOUT_MS);

    try {
      notification.show();
    } catch {
      finish("denied", false);
    }
  });
}

async function requestPluginNotificationPermission(): Promise<PluginNotificationPermission> {
  const result = await showPluginNativeNotification({
    title: `${APP_NAME} notifications`,
    body: "Native notifications are enabled for this app.",
  });
  return result.permission;
}

const clipboardHistory = new ClipboardHistory();

const MAX_CLIPBOARD_IMAGE_PIXELS = 64_000_000;
const MAX_UNKNOWN_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;

function bytesFromPaste(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

function imageDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return {
      width: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16),
      height: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(20),
    };
  }
  if (data.byteLength >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (data.byteLength >= 30 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50 && data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x58) {
    return {
      width: 1 + data[24] + (data[25] << 8) + (data[26] << 16),
      height: 1 + data[27] + (data[28] << 8) + (data[29] << 16),
    };
  }
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 2;
    while (offset + 9 < data.byteLength) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > data.byteLength) return null;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > data.byteLength) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (segmentLength < 7) return null;
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += segmentLength;
    }
  }
  return null;
}

/** Record bytes already supplied by a user paste without reading the OS clipboard. */
function recordPastedClipboardFiles(files: ComposerPasteFile[]): void {
  for (const file of files) {
    const bytes = bytesFromPaste(file?.data);
    if (!bytes) continue;
    const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
    if (file.recordHistory && mimeType.toLowerCase() === "text/plain") {
      clipboardHistory.recordText(new TextDecoder().decode(bytes));
      continue;
    }
    const isImage =
      mimeType.toLowerCase().startsWith("image/") ||
      /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(file.name ?? "");
    if (!isImage) continue;
    const dimensions = imageDimensions(bytes);
    if (
      (dimensions &&
        (dimensions.width < 1 ||
          dimensions.height < 1 ||
          dimensions.width * dimensions.height > MAX_CLIPBOARD_IMAGE_PIXELS)) ||
      (!dimensions && bytes.byteLength > MAX_UNKNOWN_CLIPBOARD_IMAGE_BYTES)
    ) continue;
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (image.isEmpty()) continue;
      const size = image.getSize();
      if (size.width * size.height > MAX_CLIPBOARD_IMAGE_PIXELS) continue;
      clipboardHistory.recordImage({
        format: "png",
        data: new Uint8Array(image.toPNG()),
        width: size.width,
        height: size.height,
      });
    } catch {
      // Invalid image bytes must not make an otherwise valid paste fail.
    }
  }
}

async function safeOpenExternal(rawUrl: unknown): Promise<void> {
  const url = parseAllowedExternalUrl(rawUrl);
  if (!url) {
    logger.app("permission", "warn", "Blocked disallowed external protocol or URL", {
      data: { url: typeof rawUrl === "string" ? rawUrl.slice(0, 256) : String(rawUrl) },
    });
    throw new Error("DISALLOWED_EXTERNAL_URL");
  }
  await shell.openExternal(url);
}

const pluginPanels = new PluginPanelHost(
  async (pluginId, channel, payload, context) =>
    plugins.invokePanelBridge(pluginId, channel, payload, context),
  // A panel reaching for an undeclared host is the shape an exfiltration
  // attempt takes, so it is logged like a denied API call rather than dropped
  // silently in the network layer.
  ({ pluginId, url }) => {
    logger.app("plugin", "warn", "plugin.api", {
      pluginId,
      code: "PERMISSION_DENIED",
      data: { api: "panel.egress", ok: false, url, ts: Date.now() },
    });
  },
  (pluginId, channel, error) => {
    logger.app("plugin", "warn", "plugin.panel.bridge", {
      pluginId,
      code: (error as { code?: string })?.code ?? "PANEL_BRIDGE_FAILED",
      data: { channel, error: String(error) },
    });
  },
);
const callPluginSessionHost = async (
  method: string,
  pluginId: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  if (!host) {
    throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
  }
  const result = await host.call(method, { ...input, pluginId });
  const changed =
    (method === "plugin.session.import" &&
      (result as { imported?: unknown })?.imported === true) ||
    (method === "plugin.session.importBatch" &&
      Number((result as { imported?: unknown })?.imported ?? 0) > 0) ||
    (method === "plugin.session.rename" &&
      (result as { updated?: unknown })?.updated === true) ||
    (method === "plugin.session.delete" &&
      (result as { deleted?: unknown })?.deleted === true);
  if (changed) {
    sendToRenderer(IPC.event.sessionsChanged, { reason: method, pluginId });
  }
  return result;
};
const callPluginProjectHost = async (
  pluginId: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  if (!host) {
    throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
  }
  const result = await host.call<{
    project?: { id?: number; path?: string; name?: string };
  }>("projects.create", { ...input, pluginId });
  const project = result.project;
  if (!project || typeof project.id !== "number" || !project.path || !project.name) {
    throw Object.assign(new Error("invalid project response"), { code: "INTERNAL" });
  }
  return { projectId: project.id, path: project.path, name: project.name };
};
const plugins: PluginRuntime = new PluginRuntime({
  getWorkspacePath: () => {
    // Filled after host boots; temporary stub until services rebinding.
    return null;
  },
  showToast: (message) => sendToRenderer(IPC.event.toast, { message }),
  notify: (input) =>
    sendToRenderer(IPC.event.toast, {
      message: `${input.title}${input.body ? `: ${input.body}` : ""}`,
    }),
  getNotificationPermission: getPluginNotificationPermission,
  requestNotificationPermission: requestPluginNotificationPermission,
  showNativeNotification: showPluginNativeNotification,
  openExternal: async (url) => {
    await safeOpenExternal(url);
  },
  openPath: async (fullPath) => {
    const error = await shell.openPath(stripWinLongPrefix(fullPath));
    if (error) throw new Error(error);
  },
  revealPath: async (fullPath) => {
    shell.showItemInFolder(stripWinLongPrefix(fullPath));
  },
  readClipboard: async () => {
    const { clipboard } = await import("electron");
    return clipboard.readText();
  },
  writeClipboard: async (value) => {
    const { clipboard } = await import("electron");
    clipboard.writeText(value);
    clipboardHistory.recordText(value);
  },
  readClipboardHistory: async () => clipboardHistory.getHistory(),
  getLocale: () => updaterLocale,
  getAppearance: () => resolveAppearance(),
  openPanel: async (request) => {
    await pluginPanels.open({
      ...request,
      locale: updaterLocale,
      theme: pluginPanelTheme,
    });
  },
  closePanel: async (pluginId) => {
    await pluginPanels.close(pluginId);
  },
  // `net.fetch` is deliberately not overridden here: the runtime's own
  // implementation follows redirects by hand and re-checks the manifest
  // egress allowlist before every hop. A plain `fetch` service would let an
  // allowlisted host 30x the request straight out to an undeclared one.
  audit: (entry) => {
    logger.app("plugin", "info", "plugin.api", entry);
  },
  // A file access the manifest did not cover is decided by the user, natively
  // and synchronously: the plugin's call is still waiting on the answer, so
  // there is no window in which the access happens before consent.
  confirmFsAccess: createFsConsentService({
    getWindow: () => mainWindow,
    getLocale: () => updaterLocale,
  }),
  // A dangerous desktop operation (session delete, permission-mode change,
  // tool approval) requested by a plugin is decided by the user in a native
  // dialog that names the catalog operation, never plugin-authored text.
  confirmDesktopControl: createDesktopConsentService({
    getWindow: () => mainWindow,
    getLocale: () => updaterLocale,
  }),
  // The OS trash is what makes a plugin delete recoverable, and it is the
  // reason none of the user's data is copied anywhere by us.
  trashItem: async (fullPath) => {
    await shell.trashItem(fullPath);
  },
  pickDirectory: async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  },
  // Refused under every root and grant: the data directory holds provider keys
  // and the session store, and a plugin reaching it would undo every other
  // limit on this list.
  protectedPaths: () => [dataDir],
  listModels: async () => {
    // Same D080 degrade as skills/MCP/subagent catalog reads: a dead
    // transport is expected during shutdown and supervised restarts.
    if (!host?.isAvailable()) return [];
    try {
      const listed = await host.call<{ providers: Array<{
        id: string;
        name: string;
        enabled?: boolean;
        hasSecret?: boolean;
        hasOauth?: boolean;
        authKind?: string;
        supportsReasoning?: boolean;
        supportedThinkingLevels?: ThinkingLevel[];
        defaultModelId?: string;
        models?: ModelBinding[];
      }> }>("providers.list", { includeDisabled: false });
      return listReadyPluginModels(listed.providers ?? []);
    } catch (error) {
      if (!isHostUnavailable(error)) throw error;
      return [];
    }
  },
  getSessionContext: async (sessionId, stripToolName) => {
    if (!host) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const detail = await host.call<{
      session?: {
        messages?: UiMessage[];
        compaction?: import("@pi-desktop/shared").ContextCompactionRecord;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: string;
      } | null;
    }>("session.get", { id: sessionId });
    return pluginSessionContextFromSession(sessionId, detail?.session, stripToolName);
  },
  session: {
    list: (pluginId, input) => callPluginSessionHost("plugin.session.list", pluginId, input),
    get: (pluginId, input) => callPluginSessionHost("plugin.session.get", pluginId, input),
    listMessages: (pluginId, input) =>
      callPluginSessionHost("plugin.session.listMessages", pluginId, input),
    import: (pluginId, input) => callPluginSessionHost("plugin.session.import", pluginId, input),
    importBatch: (pluginId, input) =>
      callPluginSessionHost("plugin.session.importBatch", pluginId, input),
    rename: (pluginId, input) => callPluginSessionHost("plugin.session.rename", pluginId, input),
    delete: (pluginId, input) => callPluginSessionHost("plugin.session.delete", pluginId, input),
  },
  project: {
    create: (pluginId, input) => callPluginProjectHost(pluginId, input),
  },
  complete: async (input): Promise<PluginCompleteResult> => {
    if (!host) {
      throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    }
    const parsed = parsePluginModelKey(input.modelKey);
    if (!parsed) {
      throw Object.assign(new Error("modelKey must be providerId/modelId"), {
        code: "INVALID_ARGUMENT",
      });
    }
    const thinkingLevel = asPluginThinkingLevel(input.thinkingLevel);
    const settings = await host.call<any>("settings.get");
    const launchSessionId = input.sessionId || `plugin-complete:${crypto.randomUUID()}`;
    const session = input.sessionId
      ? (await host.call<{ session?: any }>("session.get", { id: input.sessionId })).session
      : {};
    const launch = await resolveAgentRuntimeLaunch(launchSessionId, session ?? {}, settings, {
      mode: "agent",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      thinkingLevel,
    });
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;
    const sessionContext = input.includeSessionContext
      ? pluginSessionContextFromSession(
          String(input.sessionId ?? ""),
          session,
          input.stripToolName,
        )
      : undefined;
    const context = pluginCompleteContext({
      modelKey: input.modelKey,
      thinkingLevel: input.thinkingLevel,
      system: input.system,
      messages: input.messages,
      includeSessionContext: input.includeSessionContext,
      sessionContext,
    });
    const result = await completeOneShot(
      runtimeProvider,
      context,
      launch.sidecarParams.thinkingLevel,
      { signal: input.signal, sessionId: launchSessionId },
    );
    return {
      text: result.text,
      modelKey: `${launch.providerId}/${launch.modelId}`,
      thinkingLevel: launch.sidecarParams.thinkingLevel,
      usage: result.usage,
    };
  },
  // A plugin host process dying is contained: contributions are already
  // deregistered by the runtime, we only have to tell the user and the UI.
  onPluginCrash: ({ pluginId, exitCode }) => {
    logger.app("plugin", "error", "plugin host process crashed", {
      pluginId,
      code: "PLUGIN_CRASHED",
      data: { exitCode },
    });
    // No toast here: the runtime already raised one through `showToast` on the
    // same code path, and a second identical message reads as two failures.
    // The view's page outlived the process behind its bridge, so it is a dead
    // surface. Drop it; the renderer re-opens it on the pluginChanged event if
    // the tab is still active and the plugin came back.
    pluginViews.closePlugin(pluginId);
    if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
    sendToRenderer(IPC.event.pluginChanged,{ reason: "crash", pluginId });
  },
  // Supervision state is UI-only: the runtime owns restarts, the renderer just
  // reflects what happened.
  onServiceChange: (status) => {
    logger.app("plugin", "info", "plugin.service", {
      pluginId: status.pluginId,
      data: { serviceId: status.serviceId, state: status.state, restarts: status.restarts },
    });
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "service",
      pluginId: status.pluginId,
    });
  },
  // Hot reload happens without anyone asking for it, so it has to report
  // itself: the plugins page reads status from the host, not from the edit.
  onPluginReloaded: ({ pluginId, name, ok, message }) => {
    logger.app("plugin", ok ? "info" : "error", "development plugin reloaded", {
      pluginId,
      data: { ok, message },
    });
    sendToRenderer(IPC.event.toast, {
      message: ok ? `Reloaded ${name}` : `Reload failed: ${name} — ${message ?? ""}`,
    });
    // Views were loaded from the previous revision of the plugin's files.
    pluginViews.closePlugin(pluginId);
    if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
    sendToRenderer(IPC.event.pluginChanged,{ reason: "reload", pluginId });
  },
});
const userMcp = new UserMcpRuntime({
  createClient: (config) => new McpServerClient(config),
  connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
  callTimeoutMs: MCP_CALL_TIMEOUT_MS,
  audit: (entry) => logger.app("plugin", "info", "mcp.api", entry),
  log: (level, message, data) => logger.app("plugin", level, message, { data }),
});
/**
 * Activation scopes for the loaded plugins, keyed by plugin id.
 *
 * host-core is the source of truth; this cache exists because scope has to be
 * consulted on every session assembly and every tool dispatch, which are hot
 * paths that must not wait on an RPC round trip. It is refreshed whenever the
 * plugin list is read.
 */
const pluginScopes = new Map<string, ActivationScope>();
/**
 * Project path per live session, so a tool dispatch can be scope-checked
 * without asking host-core which project the session belongs to. Two windows
 * can hold sessions on different projects, so this cannot be a single value.
 */
const sessionProjects = new Map<string, string | null>();
const emitBrowserState = (state: BrowserState) => {
  sendToRenderer(IPC.event.browserState, state);
  pluginPanels.broadcast("browser:state", state);
  pluginViews.broadcast("browser:state", state);
};
const browserPane = new BrowserPane(emitBrowserState);
const pluginViews = new PluginViewHost(({ pluginId, url }) => {
  logger.app("plugin", "warn", "plugin.api", {
    pluginId,
    code: "PERMISSION_DENIED",
    data: { api: "view.egress", ok: false, url, ts: Date.now() },
  });
});
pluginPanels.addSenderResolver((senderId) => pluginViews.pluginIdForSender(senderId));
const browserHost = new BrowserHost({
  pane: browserPane,
  isPluginLoaded: (pluginId) => Boolean(plugins.getLoaded(pluginId)),
  getFileRoot: async (sessionId) => {
    if (sessionId) {
      try {
        const res = (await host?.call("session.get", { id: sessionId })) as
          | { session: { projectPath?: string } | null }
          | undefined;
        const path = res?.session?.projectPath?.trim();
        if (path) return path;
      } catch {
        // Fall through to the visible workspace.
      }
    }
    return currentWorkspacePath();
  },
  getScratchDir: (sessionId) => {
    if (!sessionId) return null;
    const root =
      process.env.PI_DESKTOP_DATA_DIR?.trim() ||
      join(homedir(), ".pi-desktop");
    return join(root, "scratch", sessionId);
  },
  onState: emitBrowserState,
});
pluginViews.onSurface = (surface) => {
  browserHost.setChromeSurface(surface);
};
plugins.setServices({
  agentExtensionsChanged: () =>
    sendToRenderer(IPC.event.pluginChanged, { reason: "agentExtensions" }),
  browser: {
    navigate: (input, sessionId) => browserHost.navigate(input, sessionId),
    action: (action) => browserHost.action(action),
    setBounds: (pluginId, hole) => browserHost.setGuestHole(pluginId, hole),
    setVisible: (pluginId, visible) => browserHost.setGuestVisible(pluginId, visible),
    getState: () => browserHost.getState(),
    openExternal: () => browserHost.openExternal(),
    snapshot: () => browserHost.snapshot(),
    screenshot: (input, sessionId) => browserHost.screenshot(input, sessionId),
    click: (uid) => browserHost.click(uid),
    fill: (uid, text) => browserHost.fill(uid, text),
    evaluate: (expression) => browserHost.evaluate(expression),
    console: (limit) => browserHost.console(limit),
    cdp: (method, params) => browserHost.cdpCommand(method, params),
  },
  onPluginUnload: (pluginId) => {
    if (pluginId === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
  },
});
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
async function refreshUserMcp(
  projectPath: string | null | undefined = currentWorkspacePath(),
): Promise<McpServerRecord[]> {
  // A dead transport is expected during shutdown and between supervised
  // restarts, and it rejects every call — warning about it would file the
  // routine case under the same log line as a registry that cannot be read.
  // The guard skips the calls that have not started; the catch covers the ones
  // already in flight when the transport closed.
  if (!host?.isAvailable()) return [];
  try {
    const result = await host.call<{ servers: McpServerRecord[] }>("mcp.active", {
      projectPath: projectPath ?? null,
    });
    const servers = result.servers ?? [];
    userMcp.setRecords(servers);
    return servers;
  } catch (error) {
    if (!isHostUnavailable(error)) {
      logger.app("plugin", "warn", "mcp active list failed", { data: String(error) });
    }
    return [];
  }
}

/** The user's own skills, filtered to the ones a session on this project sees. */
async function activeUserSkills(
  projectPath: string | undefined,
): Promise<UserSkillRecord[]> {
  if (!host?.isAvailable()) return [];
  try {
    const result = await host.call<{ skills: UserSkillRecord[] }>("skills.active", {
      projectPath: projectPath ?? null,
    });
    return result.skills ?? [];
  } catch (error) {
    if (!isHostUnavailable(error)) {
      logger.app("plugin", "warn", "skills list failed", { data: String(error) });
    }
    return [];
  }
}

/**
 * The user's own subagent definitions, filtered to the ones a session on this
 * project sees, as documents the runtime can parse (D202).
 *
 * host-core owns the registry and the activation scope; the document text is
 * read here because this is where the other two definition sources are read
 * too, so all three reach `loadSubagentDefinitions` in the same shape.
 */
async function activeUserSubagentDocuments(
  projectPath: string | undefined,
): Promise<UserSubagentDocument[]> {
  if (!host?.isAvailable()) return [];
  let records: UserSubagentRecord[] = [];
  try {
    const result = await host.call<{ subagents: UserSubagentRecord[] }>(
      "agents.active",
      { projectPath: projectPath ?? null },
    );
    records = result.subagents ?? [];
  } catch (error) {
    if (!isHostUnavailable(error)) {
      logger.app("plugin", "warn", "subagent list failed", { data: String(error) });
    }
    return [];
  }
  const documents: UserSubagentDocument[] = [];
  const { readFile } = await import("node:fs/promises");
  for (const record of records) {
    try {
      documents.push({
        id: record.id,
        document: await readFile(record.path, "utf8"),
        filePath: record.path,
      });
    } catch (error) {
      // A document deleted behind the registry's back is one lost delegate,
      // never a lost turn.
      logger.app("plugin", "warn", "subagent document unreadable", {
        data: { id: record.id, error: String(error) },
      });
    }
  }
  return documents;
}

/**
 * Load one of the user's own skill documents by id, or `null` if there is no
 * such skill — so the caller can fall through to the plugin catalog.
 *
 * The scope check is repeated here rather than trusted from the catalog: a
 * session can outlive the prompt that listed the skill, and re-scoping a skill
 * mid-session should take effect immediately.
 */
async function loadUserSkillBody(
  id: string,
  projectPath: string | null,
): Promise<{ id: string; name: string; body: string } | null> {
  if (!host || id.includes("/")) return null;
  const result = await host.call<{
    skill: UserSkillRecord | null;
    body: string | null;
  }>("skills.read", { id, projectPath });
  const skill = result.skill;
  if (!skill || typeof result.body !== "string") return null;
  if (!isActiveInProject(skill, projectPath)) {
    throw new Error(`skill "${id}" is not enabled for this project`);
  }
  return { id: skill.id, name: skill.name, body: result.body };
}

async function resolveEffectiveCommandShell(): Promise<CommandShellCatalog> {
  if (!host) throw new Error("host unavailable");
  const catalog = await host.call<CommandShellCatalog>("commandShells.list");
  if (!isCommandShellCatalog(catalog)) {
    throw Object.assign(new Error("Host returned an invalid command shell catalog"), {
      errorCode: ErrorCodes.COMMAND_SHELL_INVALID,
    });
  }
  if (!catalog.effective || !catalog.effective.available) {
    throw Object.assign(
      new Error("No available command shell is configured for this session"),
      { errorCode: ErrorCodes.SHELL_NOT_FOUND },
    );
  }
  return catalog;
}

async function resolveAgentRuntimeLaunch(
  sessionId: string,
  session: any,
  settings: any,
  overrides: {
    mode?: Mode;
    turnId?: string;
    providerId?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  } = {},
) {
  if (!host) throw new Error("host unavailable");
  await modelsDevCatalog.ensureLoaded();
  const commandShell = (await resolveEffectiveCommandShell()).effective!;
  const providers = await host.call<{ providers: RuntimeProvider[] }>(
    "providers.list",
    { includeDisabled: false },
  );
  const requestedProviderId = overrides.providerId ?? session.providerId;
  const provider =
    providers.providers.find((item) => item.id === requestedProviderId) ||
    providers.providers.find((item) => item.id === settings.defaultProviderId) ||
    providers.providers.find(
      (item) => item.hasSecret || item.hasOauth || item.authKind === "none",
    ) ||
    providers.providers[0];
  if (!provider) {
    throw Object.assign(new Error("No provider configured"), {
      errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
    });
  }
  // A vendor account has no long-lived key to read: the sidecar asks main for
  // short-lived request auth instead (see `provider.resolveAuth`), so the
  // launch payload deliberately carries no credential at all.
  const isVendorAccount = provider.authKind === OAUTH_AUTH_KIND;
  const secret = isVendorAccount
    ? { value: undefined }
    : await host.call<{ value?: string }>("providers.getSecret", {
        id: provider.id,
      });
  if (!secret.value && !isVendorAccount && provider.authKind !== "none") {
    throw Object.assign(new Error("Provider API key missing"), {
      errorCode: ErrorCodes.PROVIDER_SECRET_MISSING,
    });
  }
  const modelId =
    (provider.id === requestedProviderId
      ? overrides.modelId ?? session.modelId
      : undefined) ||
    (provider.id === settings.defaultProviderId
      ? settings.defaultModelId
      : undefined) ||
    provider.models?.[0]?.id ||
    provider.defaultModelId;
  if (!modelId) {
    throw Object.assign(new Error("No model selected for provider"), {
      errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
    });
  }
  // The authenticated collection owns a vendor account's available model IDs
  // and wire endpoint. models.dev owns metadata; one account can span multiple
  // wire APIs and gateway catalogs.
  const vendorBinding = isVendorAccount
    ? await vendorOAuth
        .bindingFor(provider.id, modelId)
        .catch(() => undefined)
    : undefined;
  if (isVendorAccount && !vendorBinding) {
    throw Object.assign(
      new Error(`Vendor account does not offer model "${modelId}"`),
      { errorCode: ErrorCodes.MODEL_NOT_CONFIGURED },
    );
  }
  const storedModel = bindingForModel(provider, modelId);
  const apiStyle = vendorBinding?.apiStyle ?? provider.apiStyle;
  const baseUrl = vendorBinding?.baseUrl ?? provider.baseUrl;
  const modelsDevModel = modelsDevModelFor(provider, modelId);
  const catalogModelConfig = vendorBinding?.modelConfig ??
    (modelsDevModel
      ? modelConfigFromModelsDev(modelsDevModel, baseUrl)
      : genericModelConfig(modelId, baseUrl ?? ""));
  const modelConfig = modelConfigWithBinding(catalogModelConfig, storedModel);
  const thinkingCapabilities = capabilitiesFromModelConfig(modelConfig);
  const thinkingLevel = clampThinkingLevel(
    thinkingCapabilities,
    normalizeThinkingLevel(
      overrides.thinkingLevel ??
        (provider.id === requestedProviderId ? session.thinkingLevel : undefined) ??
        storedModel?.defaultThinkingLevel,
    ),
  );
  const projectPath =
    typeof session.projectPath === "string" && session.projectPath.trim()
      ? session.projectPath.trim()
      : undefined;
  const projectInstructions = await loadInstructionChain(projectPath);
  sessionProjects.set(sessionId, projectPath ?? null);
  // Everything below is filtered by activation scope: a plugin, MCP server or
  // skill limited to certain projects must be invisible to a session on any
  // other one — not merely refused when called, since a tool the model can see
  // is a tool it will try.
  const userSkills = await activeUserSkills(projectPath);
  await refreshUserMcp(projectPath);
  const userMcpTools = await userMcp.toolsForProject(projectPath ?? null);
  // Skill catalog (D174): only id/name/description cross to the sidecar; the
  // document body is fetched on demand through the local `Skill` tool. Host
  // skills come first so a plugin's entry reads as a refinement of them, and
  // the user's own skills come last so they win a name clash in the model's
  // reading order.
  const pluginSkills = [
    ...builtinSkills({
      workspacePath: projectPath,
      pluginPaths: plugins.listLoaded().map((loaded) => loaded.path),
    }),
    ...plugins
      .getSkills()
      .filter((skill) => pluginActiveInProject(skill.pluginId, projectPath))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      })),
    ...userSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
  ];
  // Subagents (ADR 0062): definitions are re-read per launch so editing
  // `~/.agents/subagents` or the registry takes effect on the next prompt, and every
  // pinned model is resolved here because credentials and the models.dev catalog
  // live on this side. The user's own definitions (D202) are scope-filtered like the
  // skills above; a delegate the model can see is one it will try to call.
  const subagentCatalog = await loadSubagentDefinitions(projectPath, {
    userDocuments: await activeUserSubagentDocuments(projectPath),
  });
  const subagentBindings = await resolveSubagentProviders({
    definitions: subagentCatalog.definitions,
    providers: providers.providers,
    getSecret: async (id: string) =>
      (await host!.call<{ value?: string }>("providers.getSecret", { id })).value,
    resolveVendorBinding: (pinned, pinnedModelId) =>
      vendorOAuth.bindingFor(pinned.id, pinnedModelId),
    resolveModel: async (pinned, pinnedModelId) => {
      const model = modelsDevCatalog.findModel({
        vendorKey: pinned.vendorKey,
        baseUrl: pinned.baseUrl,
        modelId: pinnedModelId,
      });
      const catalogModelConfig = model
        ? modelConfigFromModelsDev(model, pinned.baseUrl)
        : genericModelConfig(pinnedModelId, pinned.baseUrl ?? "");
      const configuredProvider = providers.providers.find(
        (candidate) => candidate.id === pinned.id,
      );
      return configuredProvider
        ? effectiveSubagentModelConfig(
            configuredProvider,
            pinnedModelId,
            catalogModelConfig,
          )
        : {
            modelConfig: catalogModelConfig,
            capabilities: capabilitiesFromModelConfig(catalogModelConfig),
          };
    },
  });
  // Delegation model catalog: every model binding flagged
  // `availableForSubagents` is pre-resolved so the system prompt can list
  // them and the parent agent can pass them to `Task.model` without an
  // extra RPC round-trip. Statically pinned entries from definitions take
  // precedence — they were resolved above with stricter diagnostics.
  for (const row of providers.providers) {
    if (!row.enabled) continue;
    for (const binding of row.models ?? []) {
      if (!binding.availableForSubagents) continue;
      const key = `${row.vendorKey ?? row.name}/${binding.id}`;
      if (subagentBindings.providers[key]) continue; // already pinned
      const isVendorAccount = row.authKind === OAUTH_AUTH_KIND;
      let apiKey = "";
      if (!isVendorAccount && row.authKind !== "none") {
        try {
          apiKey =
            (
              await host!.call<{ value?: string }>("providers.getSecret", {
                id: row.id,
              })
            ).value ?? "";
        } catch {
          continue; // skip if secret unavailable
        }
        if (!apiKey) continue;
      }
      let catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0];
      if (isVendorAccount) {
        const vb = await vendorOAuth.bindingFor(row.id, binding.id);
        if (!vb) continue;
        catalogModelConfig =
          vb.modelConfig ?? genericModelConfig(binding.id, vb.baseUrl ?? row.baseUrl ?? "");
      } else {
        const model = modelsDevCatalog.findModel({
          vendorKey: row.vendorKey,
          baseUrl: row.baseUrl,
          modelId: binding.id,
        });
        catalogModelConfig = model
          ? modelConfigFromModelsDev(model, row.baseUrl)
          : genericModelConfig(binding.id, row.baseUrl ?? "");
      }
      const effective = effectiveSubagentModelConfig(
        row,
        binding.id,
        catalogModelConfig,
      );
      const mc = effective.modelConfig;
      const caps = effective.capabilities;
      subagentBindings.providers[key] = {
        id: row.id,
        name: row.name,
        ...(row.vendorKey ? { vendorKey: row.vendorKey } : {}),
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        modelId: binding.id,
        apiKey,
        ...(row.authKind ? { authKind: row.authKind } : {}),
        ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
        ...optionalProviderHeaders(row.headers),
        supportsReasoning: caps.supportsReasoning,
        supportedThinkingLevels: [...caps.supportedThinkingLevels],
        ...(mc ? { modelConfig: mc } : {}),
      };
    }
  }

  const subagentDiagnostics = [
    ...subagentCatalog.diagnostics,
    ...subagentBindings.diagnostics,
  ];
  if (subagentDiagnostics.length > 0) {
    logger.app("session", "warn", "subagent definitions have problems", {
      sessionId,
      data: { diagnostics: subagentDiagnostics },
    });
  }
  // Bind the vendor-account rows this turn is allowed to sign requests with:
  // the session's own provider plus any row a pinned subagent resolved to. The
  // sidecar may then ask main for request auth, but only for a row named here,
  // and the set is rewritten on every launch.
  sidecar?.setVendorAuthBindings(
    sessionId,
    [
      provider.id,
      ...Object.values(subagentBindings.providers).map((binding) => binding.id),
    ]
      .map((id) => providers.providers.find((row) => row.id === id))
      .flatMap((row) =>
        row?.authKind === OAUTH_AUTH_KIND
          ? [{ providerId: row.id }]
          : [],
      ),
  );
  return {
    providerId: provider.id,
    modelId,
    projectPath,
    sidecarParams: {
      sessionId,
      mode: normalizeMode(
        overrides.mode ?? session.mode ?? settings.defaultMode ?? "agent",
      ),
      ...(overrides.turnId ? { turnId: overrides.turnId } : {}),
      thinkingLevel,
      commandShell,
      scratchDir: join(dataDir, "scratch", sessionId),
      attachmentsDir: join(dataDir, "attachments"),
      projectPath,
      projectInstructions,
      provider: {
        id: provider.id,
        name: provider.name,
        vendorKey: provider.vendorKey,
        baseUrl,
        modelId,
        apiKey: secret.value || "",
        authKind: provider.authKind,
        apiStyle,
        ...optionalProviderHeaders(provider.headers),
        supportsReasoning: thinkingCapabilities.supportsReasoning,
        supportsVision: visionFromModelConfig(modelConfig),
        supportedThinkingLevels: [...thinkingCapabilities.supportedThinkingLevels],
        ...(modelConfig ? { modelConfig } : {}),
      },
      pluginTools: [
        ...plugins
          .getTools()
          .filter((tool) => pluginActiveInProject(tool.pluginId, projectPath))
          .map((tool) => ({
            name: tool.fullName,
            description: tool.description,
            parameters: tool.schema ?? { type: "object", properties: {} },
            ...(tool.risk === "low" || tool.risk === "medium" || tool.risk === "high"
              ? { risk: tool.risk as Risk }
              : {}),
            // Plan-safe action list is forwarded to host-core so it can
            // admit the tool in Plan/Goal modes (ADR 0211).
            ...(tool.planSafeActions && tool.planSafeActions.length > 0
              ? { planSafeActions: tool.planSafeActions }
              : {}),
          })),
        ...userMcpTools.map((tool) => ({
          name: tool.fullName,
          description: tool.description,
          parameters: tool.schema ?? { type: "object", properties: {} },
        })),
      ],
      // Plugin skills (D174): only the catalog crosses to the sidecar; the
      // document body is fetched on demand through the local `Skill` tool.
      pluginSkills,
      // Trusted extensions enabled for this project (spec 16 §3.2). The set
      // is part of the runtime match, so a toggle retires the runtime.
      trustedExtensions: plugins
        .getAgentExtensions()
        .filter((extension) => pluginActiveInProject(extension.pluginId, projectPath))
        .map((extension) => ({
          id: extension.id,
          entry: extension.entry,
          label: extension.pluginName,
          source: "plugin" as const,
          root: extension.root,
        })),
      subagents: subagentCatalog.definitions,
      subagentProviders: subagentBindings.providers,
    },
  };
}

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
      const window = mainWindow;
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
  if (!tray) return;
  const labels = catalogs[resolveLocale(locale)].tray;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.open, click: restoreMainWindow },
      { type: "separator" },
      { label: labels.quit, click: () => app.quit() },
    ]),
  );
}

function createTray() {
  if (tray) return;
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

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on("click", restoreMainWindow);
  tray.on("double-click", restoreMainWindow);
  updateTrayMenu();
}


function sendToRenderer(channel: string, payload: unknown) {
  if (channel === IPC.event.pluginChanged) {
    applyNativeThemeSource({ theme: appThemePreference });
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

function resetMenuRendererReady(window: BrowserWindow) {
  menuRendererReadyGate?.resolve();
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  menuRendererReadyGate = {
    window,
    ready: false,
    promise,
    resolve,
  };
}

function markMenuRendererReady(window: BrowserWindow): boolean {
  const gate = menuRendererReadyGate;
  if (gate?.window !== window || window.isDestroyed()) return false;
  gate.ready = true;
  gate.resolve();
  return true;
}

async function waitForMenuRenderer(window: BrowserWindow): Promise<boolean> {
  const gate = menuRendererReadyGate;
  if (gate?.window !== window) return false;
  await gate.promise;
  return (
    menuRendererReadyGate === gate &&
    gate.ready &&
    mainWindow === window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed()
  );
}

function createWindowForLifecycle(): Promise<void> {
  return createWindowInBootstrap({
    state: windowLifecycleState,
    dataDir,
    windowMinWidth: WINDOW_MIN_WIDTH,
    windowMinHeight: WINDOW_MIN_HEIGHT,
    windowBoundsSettleMs: WINDOW_BOUNDS_SETTLE_MS,
    workPanelNativeResizeSettleMs: WORK_PANEL_NATIVE_RESIZE_SETTLE_MS,
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
  if (windowCreationPromise) {
    await windowCreationPromise;
    return true;
  }
  if (mainWindow && !mainWindow.isDestroyed()) return false;

  const creation = createWindowForLifecycle();
  windowCreationPromise = creation;
  try {
    await creation;
    return true;
  } finally {
    if (windowCreationPromise === creation) windowCreationPromise = null;
  }
}

async function deliverApplicationMenuCommand(command: AppMenuCommand) {
  await ensureWindow();
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (!(await waitForMenuRenderer(window))) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  sendToRenderer(IPC.event.menuCommand, { command });
}

function dispatchApplicationMenuCommand(command: AppMenuCommand) {
  if (!APP_MENU_COMMANDS.includes(command)) return;
  if (!applicationBooted) {
    pendingApplicationMenuCommands.push(command);
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
  target: BrowserWindow | null = mainWindow,
) {
  if (action === "restoreMainWindow") {
    restoreMainWindow();
    const window = mainWindow;
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

let appliedMenuSettings: string | null = null;

/**
 * Devtools stay locked until the user opts in via settings (D-dev mode);
 * mirrors `AppSettings.developerMode` so the IPC handler, the F12 shortcut
 * and the macOS View menu all read one flag.
 */
let developerMode = false;

function applyDeveloperMode(settings?: { developerMode?: unknown } | null) {
  const next = settings?.developerMode === true;
  if (next === developerMode) return;
  developerMode = next;
  // Leaving developer mode should not strand an open console.
  if (!next && mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
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
  if (process.platform === "darwin" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setVibrancy("sidebar");
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
  if (locale !== updaterLocale) {
    updaterLocale = locale;
    updater.refreshReleaseNotes();
  }
  const preference = settings?.theme;
  appThemePreference =
    preference === "light" || preference === "dark"
      ? preference
      : typeof preference === "string" && preference.startsWith("plugin:")
        ? preference
        : "system";
  applyNativeThemeSource(settings);
  if (preference === "light" || preference === "dark") {
    pluginPanelTheme = preference;
  } else if (typeof preference === "string" && preference.startsWith("plugin:")) {
    const pluginTheme = plugins.getThemes().find((theme) => theme.id === preference);
    pluginPanelTheme =
      pluginTheme?.base ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  } else {
    pluginPanelTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
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
  if (appliedMenuSettings === signature) return;
  appliedMenuSettings = signature;
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
  let base: PluginAppearance["base"] = pluginPanelTheme;
  let pluginTheme: PluginAppearance["pluginTheme"] = null;
  if (appThemePreference.startsWith("plugin:")) {
    const theme = plugins.getThemes().find((item) => item.id === appThemePreference);
    if (theme) {
      base = theme.base;
      pluginTheme = { id: theme.id, base: theme.base, css: theme.css };
    } else {
      base = "system";
    }
  }
  return { theme: appThemePreference, base, locale: updaterLocale, pluginTheme };
}

/** Push the current appearance to every open plugin panel, when it changed. */
function broadcastAppearance(): void {
  const appearance = resolveAppearance();
  const signature = JSON.stringify(appearance);
  if (signature === broadcastAppearanceSignature) return;
  broadcastAppearanceSignature = signature;
  broadcastPluginPanelEvent("appearance:changed", appearance);
}

function flushPendingApplicationMenuCommands() {
  const commands = pendingApplicationMenuCommands.splice(0);
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

function scheduledPath() {
  return join(dataDir, "scheduled-tasks.json");
}

/// Scheduled tasks live in host-core SQLite (schema v2, D086). This one-shot
/// import moves the legacy Electron JSON store into the host, then renames the
/// file so it never imports twice. Idempotent on the host side too.
async function importLegacyScheduled() {
  if (!host) return;
  const { readFile, rename } = await import("node:fs/promises");
  const path = scheduledPath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const res = await host.call<{ imported: number }>("scheduled.import", {
        tasks: parsed,
      });
      logger.app("persistence", "info", "legacy scheduled tasks imported", {
        data: { imported: res.imported, total: parsed.length },
      });
    }
    await rename(path, `${path}.imported.bak`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      logger.app("persistence", "warn", "legacy scheduled import failed", { data: String(e) });
    }
  }
}

/** sessionId → open host turn id, for turn bookkeeping across agent events. */
const activeTurns = new Map<string, string>();
const sessionOperationTails = new Map<string, Promise<void>>();

async function acquireSessionOperation(sessionId: string): Promise<() => void> {
  const id = sessionId.trim();
  const previous = sessionOperationTails.get(id) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = previous.then(() => current);
  sessionOperationTails.set(id, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resolveCurrent();
    if (sessionOperationTails.get(id) === tail) {
      sessionOperationTails.delete(id);
    }
  };
}
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
const turnSettlements = new Map<string, Set<() => void>>();
const turnFinalizations = new Map<string, Promise<void>>();
/** sessionId -> last assistant usage recorded for active turn */
const activeTurnUsages = new Map<string, MessageUsage>();

function addActiveTurnUsage(sessionId: string, usage: MessageUsage | undefined) {
  if (!usage) return;
  const next = addUsage(activeTurnUsages.get(sessionId), usage);
  if (next) activeTurnUsages.set(sessionId, next);
}
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

function activeToolCallKey(sessionId: string, toolCallId: string) {
  return `${sessionId}:${toolCallId}`;
}

function planSubmissionTurnKey(sessionId: string, turnId: string) {
  return `${sessionId}:${turnId}`;
}

function waitForTurnSettlement(sessionId: string, turnId: string): Promise<void> {
  if (activeTurns.get(sessionId) !== turnId) return Promise.resolve();
  const key = planSubmissionTurnKey(sessionId, turnId);
  return new Promise((resolve) => {
    const waiters = turnSettlements.get(key) ?? new Set<() => void>();
    waiters.add(resolve);
    turnSettlements.set(key, waiters);
  });
}

function shouldCreateTaskNotification(sessionId: string) {
  const liveWindow = mainWindow !== null && !mainWindow.isDestroyed();
  return shouldCreateTaskNotificationPolicy({
    finishingSessionId: sessionId,
    viewingSessionId: notificationViewingSessionId,
    windowVisible: liveWindow && mainWindow?.isVisible() === true,
    windowFocused: liveWindow && mainWindow?.isFocused() === true,
  });
}

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
function applyCloseBehavior(next: CloseBehavior) {
  closeBehavior = next;
  writeCloseBehavior(dataDir, next);
  if (next === "tray") createTray();
}

/**
 * First-close prompt on Windows/Linux: asks whether closing the window
 * should hide the app to the tray or exit it. The choice is persisted and
 * can be changed later in Settings. Returns null when the user cancels.
 */
async function askCloseBehavior(
  window: BrowserWindow,
): Promise<"tray" | "quit" | null> {
  const labels = catalogs[resolveLocale(updaterLocale)];
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: labels.tray.askTitle,
    message: labels.tray.askTitle,
    detail: labels.tray.askBody,
    buttons: [labels.common.cancel, labels.tray.closeToTray, labels.tray.quit],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  return response === 1 ? "tray" : response === 2 ? "quit" : null;
}

/**
 * Quit-confirmation dialog shown on explicit quit (Cmd+Q, tray quit, menu Quit).
 * Data is already saved as part of the normal shutdown sequence, but this
 * gives the user a chance to cancel before that process begins.
 * Returns `true` when the user confirms, `false` when they cancel.
 */
async function confirmQuitDialog(): Promise<boolean> {
  const labels = catalogs[resolveLocale(updaterLocale)];
  const parent =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options = {
    type: "warning" as const,
    title: labels.tray.confirmQuitTitle,
    message: labels.tray.confirmQuitTitle,
    detail: labels.tray.confirmQuitBody,
    buttons: [labels.common.cancel, labels.tray.confirmQuit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

function workPanelMinimumWindowWidth() {
  return WINDOW_MIN_WIDTH + workPanelReservation.width;
}

function observedWorkPanelBaseBounds(
  currentBounds: WindowBounds,
  displayTransition: DisplayTransition,
) {
  if (!workPanelBaseBounds || !workPanelLastAppliedBounds) {
    return baseWindowBounds(currentBounds, workPanelReservation);
  }
  return reconcileBaseWindowBounds({
    baseBounds: workPanelBaseBounds,
    lastAppliedBounds: workPanelLastAppliedBounds,
    currentBounds,
    displayTransition,
    reservation: workPanelReservation,
  });
}

function markWorkPanelChatResizeActive() {
  workPanelChatResizeActive = true;
  if (workPanelChatResizeTimer) clearTimeout(workPanelChatResizeTimer);
  workPanelChatResizeTimer = setTimeout(() => {
    workPanelChatResizeTimer = null;
    workPanelChatResizeActive = false;
  }, WORK_PANEL_CHAT_RESIZE_SETTLE_MS);
}

/**
 * Classifies a display change. A user drag is the only transition that follows
 * a native move stream, so a pending move is the signal that separates it from
 * an OS re-fit (D263). Without that split, dragging a window to another display
 * replanned the reservation from the previous display's base bounds and snapped
 * the window back (issue #18).
 */
function classifyDisplayTransition(nextDisplayKey: string): DisplayTransition {
  if (workPanelDisplayKey === null || nextDisplayKey === workPanelDisplayKey) {
    return "none";
  }
  return workPanelUserMovePending ? "user-moved" : "os-adjusted";
}

function applyWorkPanelReservation(): WorkPanelReservationState {
  // The work panel is rendered inside the existing BrowserWindow. This helper
  // remains as a no-op for recovery call sites from the old reservation path,
  // but opening or collapsing the panel must never mutate native bounds.
  requestedWorkPanelReservation = 0;
  workPanelReservation = emptyWorkPanelReservationState();
  return workPanelReservation;
}

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
  if (pluginLauncherCreationPromise) return pluginLauncherCreationPromise;
  if (pluginLauncherWindow && !pluginLauncherWindow.isDestroyed()) {
    return Promise.resolve(pluginLauncherWindow);
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
    pluginLauncherWindow = window;

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
      if (pluginLauncherWindow === window) pluginLauncherWindow = null;
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

  pluginLauncherCreationPromise = creation;
  void creation.then(
    () => {
      if (pluginLauncherCreationPromise === creation) {
        pluginLauncherCreationPromise = null;
      }
    },
    () => {
      if (pluginLauncherCreationPromise === creation) {
        pluginLauncherCreationPromise = null;
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
  if (!applicationBooted) return;
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
  const window = pluginLauncherWindow;
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
  pluginLauncherBinding = binding;

  if (process.platform === "win32" && host?.isAvailable()) {
    void host
      .call("keyboard.setGlobalShortcut", { binding })
      .catch((error) =>
        logger.app("diagnostics", "warn", "Windows global shortcut mode update failed", {
          data: String(error),
        }),
      );
  }

  if (pluginLauncherAccelerator && pluginLauncherAccelerator !== accelerator) {
    globalShortcut.unregister(pluginLauncherAccelerator);
    pluginLauncherAccelerator = null;
  }

  // Windows reserves Alt+Space for the active window system menu. The
  // host-core low-level hook owns this exact binding so it still works while
  // another application is focused; do not ask Electron to register it too.
  if (process.platform === "win32" && binding === "Alt+Space") return;
  if (!accelerator || accelerator === pluginLauncherAccelerator) return;
  const registered = globalShortcut.register(accelerator, () => {
    void togglePluginLauncher().catch((error) =>
      logger.app("diagnostics", "error", "plugin launcher shortcut failed", {
        data: String(error),
      }),
    );
  });
  if (registered) {
    pluginLauncherAccelerator = accelerator;
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

  if (summonWindowAccelerator && summonWindowAccelerator !== accelerator) {
    globalShortcut.unregister(summonWindowAccelerator);
    summonWindowAccelerator = null;
  }

  if (!accelerator || accelerator === summonWindowAccelerator) return;
  const registered = globalShortcut.register(accelerator, () => {
    restoreMainWindow();
  });
  if (registered) {
    summonWindowAccelerator = accelerator;
  } else {
    logger.app("diagnostics", "warn", "summon window shortcut unavailable", {
      data: { accelerator, platform: process.platform },
    });
  }
}


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

app.whenReady().then(async () => {
  // A launch that lost the single-instance lock is already quitting. Never
  // create a window, a tray, or a child process on top of the running app.
  if (!hasSingleInstanceLock) return;
  applyDevelopmentBranding();
  // Load the close-behavior preference before the first window exists: the
  // close handler reads `closeBehavior` synchronously, and a window created
  // while it still held the "ask" default would prompt a user who already
  // chose.
  const storedBehavior = readCloseBehavior(dataDir);
  if (storedBehavior) closeBehavior = storedBehavior;
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
  agentHostBridge = createAgentHostBridge({
    invoke: invokeIpc,
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: (sessionId) => activeTurns.has(sessionId) || turnFinalizations.has(sessionId),
    onQueueChange: (event) => sendToRenderer(IPC.event.agentQueueChanged, event),
    log: (level, message, data) => logger.app("runtime", level, message, { data }),
  });
  const control = createMcpControlController({
    invoke: invokeIpc,
    channels: IPC.invoke,
    onOperationComplete: async (operation, result, args) => {
      const event = mcpControlRendererEvent(operation, result, args);
      if (event) sendToRenderer(IPC.event.sessionsChanged, event);
    },
  });
  desktopControl = control;
  plugins.setServices({ desktopControl: control });
  // Load the local model snapshot immediately. A changed APP_VERSION marks the
  // snapshot stale, so every release performs one bounded update without
  // blocking the first window; Settings can force the same refresh on demand.
  void modelsDevCatalog.ensureLoaded();
  let bootError: unknown = null;
  try {
    await bootBackends();
  } catch (e) {
    bootError = e;
    logger.app("runtime", "error", "backend boot failed", {
      code: ErrorCodes.HOST_UNAVAILABLE,
      data: String(e),
    });
  }
  if (!bootError) planUiProbe.install();
  if (!bootError && agentHostBridge) {
    // Restore the persisted turn queue now that host-core answers. Restored
    // entries stay held until a controller attaches (D375).
    agentHostBridge.agentHost.start().catch((error) => {
      logger.app("runtime", "warn", "agent host queue restore failed", { data: String(error) });
    });
  }
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
      mcpControl = new McpControlServer({
        dataDir,
        invoke: invokeIpc,
        channels: IPC.invoke,
        version: APP_VERSION,
        port: process.env.PI_DESKTOP_MCP_PORT
          ? Number(process.env.PI_DESKTOP_MCP_PORT)
          : undefined,
        controller: desktopControl ?? undefined,
        log: (level, message, data) => logger.app("runtime", level, message, { data }),
      });
      await mcpControl.start();
    } catch (error) {
      logger.app("runtime", "warn", "MCP control server failed to start", {
        data: String(error),
      });
      mcpControl = null;
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
    applicationBooted = true;
    flushPendingApplicationMenuCommands();
  }, 300);

  // Headless boot probe for automated e2e (scripts/e2e-electron-boot.mjs):
  // verifies sandboxed preload bridge + a full IPC round-trip, then quits.
  if (process.env.PI_DESKTOP_BOOT_PROBE === "1") {
    setTimeout(() => {
      void (async () => {
        try {
          const probe = await mainWindow!.webContents.executeJavaScript(
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
          console.log("BOOT_PROBE", JSON.stringify(probe));
        } catch (e) {
          console.log(
            "BOOT_PROBE",
            JSON.stringify({ ok: false, reason: String(e) }),
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
    const initialHost = host;
    setTimeout(() => {
      logger.app("runtime", "info", "supervision probe: killing host-core");
      (initialHost as any)?.child?.kill("SIGKILL");
    }, 1500);
    const t0 = Date.now();
    const poll = setInterval(() => {
      void (async () => {
        if (Date.now() - t0 > 30_000) {
          clearInterval(poll);
          console.log(
            "SUPERVISION_PROBE",
            JSON.stringify({ ok: false, reason: "timeout" }),
          );
          app.quit();
          return;
        }
        if (!host || host === initialHost) return;
        try {
          const health = await host.call<{ ok: boolean }>("app.health");
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

app.on("window-all-closed", () => {
  // The D216 tray is resident on every platform, so its presence says nothing
  // about whether the app should survive a closed window — the user's close
  // behavior does. Under "tray" a window destroyed for any reason must not
  // take the app down (the tray click recreates it); otherwise closing the
  // last window on Windows/Linux exits the app as before.
  if (process.platform === "darwin") return;
  if (closeBehavior === "tray" && tray) return;
  app.quit();
});

/** Upper bound on the time quit spends waiting for streaming replies to settle. */
const QUIT_TURN_SETTLE_BUDGET_MS = 2_000;

async function settleRunningTurnsForQuit(): Promise<void> {
  const sessions = [...activeTurns.keys()];
  const deadline = Date.now() + QUIT_TURN_SETTLE_BUDGET_MS;
  // The newest snapshot of every streaming reply lands first: it is the
  // fallback if the abort below does not produce a final row in time.
  await inflightCheckpointer.flushAll();
  if (sessions.length === 0) {
    await persistenceOutbox.flush(() => host);
    return;
  }
  if (sidecar) {
    const activeSidecar = sidecar;
    await Promise.allSettled(
      sessions.map((sessionId) =>
        Promise.race([
          activeSidecar.call("agent.abort", { sessionId }),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]),
      ),
    );
  }
  // The abort surfaces as message_end + error/agent_end, which finishTurn
  // turns into a settled turn and an outbox append. Wait for that, bounded.
  while (Date.now() < deadline) {
    await persistenceOutbox.flush(() => host);
    if (activeTurns.size === 0 && persistenceOutbox.size() === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await persistenceOutbox.flush(() => host);
  if (activeTurns.size > 0 || persistenceOutbox.size() > 0) {
    logger.app("lifecycle", "warn", "quit before streaming replies settled", {
      data: { running: activeTurns.size, pendingAppends: persistenceOutbox.size() },
    });
  }
}

app.on("before-quit", (event) => {
  // A duplicate launch has no host, sidecar, panel, or outbox of its own, and
  // the shutdown sequence below would write into the running instance's data
  // directory. Let it exit straight away.
  if (!hasSingleInstanceLock) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;

  // Show a confirmation dialog on the first explicit quit (Cmd+Q, tray quit,
  // application-menu Quit). The data-saving shutdown runs after confirmation.
  // Skip confirmation in automated probe/capture modes where no human is
  // present to interact with the dialog.
  const isAutomatedMode =
    process.env.PI_DESKTOP_BOOT_PROBE === "1" ||
    process.env.PI_DESKTOP_SUPERVISION_PROBE === "1" ||
    process.env.PI_DESKTOP_CAPTURE === "1";
  if (!quitConfirmed && !isAutomatedMode) {
    quitConfirmed = true;
    void confirmQuitDialog().then((confirmed) => {
      if (confirmed) {
        app.quit();
      } else {
        // User cancelled: allow future quit requests to prompt again.
        quitConfirmed = false;
      }
    });
    return;
  }

  quitting = true;
  tray?.destroy();
  tray = null;
  if (pluginLauncherAccelerator) {
    globalShortcut.unregister(pluginLauncherAccelerator);
    pluginLauncherAccelerator = null;
  }
  if (summonWindowAccelerator) {
    globalShortcut.unregister(summonWindowAccelerator);
    summonWindowAccelerator = null;
  }
  shutdownPromise = (async () => {
    // Replies still streaming are stopped through the sidecar first so their
    // aborted final rows can reach the transcript while host-core is alive;
    // whatever does not make it in time is covered by the last checkpoint
    // (D299). Bounded: a quit must not hang on an unresponsive provider.
    await settleRunningTurnsForQuit();
    const hostShutdown = host?.dispose();
    const mcpShutdown = mcpControl?.stop();
    const pluginPanelShutdown = pluginPanels.closeAll();
    updater.dispose();
    logger.app("lifecycle", "info", "app shutdown");
    // Plugin hosts are stopped as a shutdown, not left for the process teardown
    // to kill: an unannounced exit is indistinguishable from a crash, and would
    // end every quit in error logs, toasts, and restarts into a closing app.
    const pluginShutdown = plugins.disposeAll();
    userMcp.disposeAll();
    browserPane.dispose();
    pluginViews.dispose();
    inflightCheckpointer.dispose();
    const sidecarShutdown = sidecar?.dispose();

    try {
      await hostShutdown;
    } catch (error) {
      logger.app("lifecycle", "warn", "host shutdown failed", { data: String(error) });
    }
    await Promise.allSettled([
      pluginPanelShutdown,
      pluginShutdown,
      sidecarShutdown,
      mcpShutdown,
    ]);
  })();

  const releaseQuit = () => {
    shutdownComplete = true;
    app.quit();
  };
  void shutdownPromise.then(releaseQuit, releaseQuit);
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
    if (quitting || !applicationBooted || hasVisibleWindow()) return;
    restoreMainWindow();
  });
}
