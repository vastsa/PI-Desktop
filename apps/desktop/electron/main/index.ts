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
} from "electron";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { listInstalledFonts } from "./system-fonts";
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
  assertFeedbackIssueUrl,
  buildBugReportUrl,
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
  draftMatchesExisting,
  isModelConfigImportSource,
  modelConfigImportKey,
  providerCreateInputFromDraft,
  publicModelConfigCandidate,
  type ModelConfigImportDraft,
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
  type HostStatusEvent,
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
  globalInstructionPath,
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
  GLIBC_UNSUPPORTED_STATUS,
  assertLinuxGlibcSupported,
  isGlibcUnsupportedError,
} from "./linux-glibc";
import {
  DB_SCHEMA_TOO_NEW_STATUS,
  detectRuntimeArch,
  isDbSchemaTooNewError,
  schemaTooNewOf,
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
import {
  convertSession,
  scanAllSources,
  scanModelConfigs,
  type ExternalSessionSummary,
  type ExternalSource,
} from "./importers";
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
let scannedImportSessions = new Map<string, ExternalSessionSummary>();
let scannedModelConfigs = new Map<string, ModelConfigImportDraft>();

const IMPORT_SOURCES = new Set<ExternalSource>([
  "claude-code",
  "opencode",
  "codex",
  "pi",
]);

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

type RuntimeProvider = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  modelId?: string;
  models?: ModelBinding[];
  defaultModelId?: string;
  apiKey?: string;
  authKind?: string;
  apiStyle?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  oauthAccountLabel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  supportsVision?: boolean;
};

type RuntimeSession = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

function bindingForModel(
  provider: Pick<RuntimeProvider, "models">,
  modelId: string,
): ModelBinding | undefined {
  return provider.models?.find((binding) => modelIdsMatch(binding.id, modelId));
}

function modelsDevModelFor(
  provider: RuntimeProvider,
  modelId: string,
) {
  return modelsDevCatalog.findModel({
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
    modelId,
  });
}

/**
 * Apply the exact provider/model binding before exposing a model to a
 * subagent. The catalog supplies the baseline, but an explicit binding owns
 * the effective thinking capability for the endpoint (D283).
 */
function effectiveSubagentModelConfig(
  provider: Pick<RuntimeProvider, "models">,
  modelId: string,
  catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0],
) {
  const modelConfig = modelConfigWithBinding(
    catalogModelConfig,
    bindingForModel(provider, modelId),
  );
  return {
    modelConfig,
    capabilities: capabilitiesFromModelConfig(modelConfig),
  };
}

function enrichProvider<T extends RuntimeProvider>(
  provider: T,
  selectedModelId?: string,
): T & ThinkingCapabilities & { supportsVision: boolean } {
  const modelId =
    selectedModelId || provider.modelId || provider.models?.[0]?.id || provider.defaultModelId || "";
  const storedModel = bindingForModel(provider, modelId);
  const modelsDevModel = modelsDevModelFor(provider, modelId);
  // The generic shape is the same fallback the launch path uses, so a model the
  // catalog does not describe still reports the capabilities its binding
  // overrides — otherwise a hand-typed id would advertise no image input here
  // while the transport happily inlined one.
  const modelConfig = modelConfigWithBinding(
    modelsDevModel
      ? modelConfigFromModelsDev(modelsDevModel, provider.baseUrl)
      : genericModelConfig(modelId, provider.baseUrl ?? ""),
    storedModel,
  );
  // Provider discovery is lazy in the renderer. Publish the same effective
  // limits on the provider snapshot so the context inspector is correct before
  // Composer has loaded the per-provider model list.
  const models = provider.models?.map((binding) => {
    const catalogModel = modelsDevModelFor(provider, binding.id);
    if (!catalogModel) return binding;
    const effective = modelConfigWithBinding(
      modelConfigFromModelsDev(catalogModel, provider.baseUrl),
      binding,
    );
    return {
      ...binding,
      contextWindow: effective.contextWindow,
      maxTokens: effective.maxTokens,
    };
  });
  return {
    ...provider,
    ...(models ? { models } : {}),
    ...(modelsDevModel
      ? {
          contextWindow: modelConfig.contextWindow,
          maxOutputTokens: modelConfig.maxTokens,
        }
      : {}),
    ...capabilitiesFromModelConfig(modelConfig),
    supportsVision: visionFromModelConfig(modelConfig),
  };
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : "off";
}

function normalizeSettings<T>(settings: T): T & {
  defaultCommandShell: CommandShellId;
} {
  const value = (
    settings && typeof settings === "object" ? settings : {}
  ) as T & {
    defaultCommandShell?: unknown;
  };
  return {
    ...(value as T),
    defaultCommandShell: isCommandShellId(value.defaultCommandShell)
      ? value.defaultCommandShell
      : defaultCommandShellForPlatform(process.platform),
  } as T & {
    defaultCommandShell: CommandShellId;
  };
}

function validateSettingsWrite<T>(settings: T): T {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }
  const value = settings as T & {
    defaultCommandShell?: unknown;
    networkProxy?: unknown;
  };
  if (
    Object.prototype.hasOwnProperty.call(value, "defaultCommandShell") &&
    !isCommandShellId(value.defaultCommandShell)
  ) {
    throw Object.assign(new Error("defaultCommandShell is invalid"), {
      errorCode: ErrorCodes.COMMAND_SHELL_INVALID,
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, "networkProxy")) {
    const proxy = validateNetworkProxy(
      (value as { networkProxy?: unknown }).networkProxy,
    );
    if (!proxy.ok) {
      throw Object.assign(new Error(proxy.error), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    value.networkProxy = proxy.value;
  }
  return settings;
}

async function enrichProviderList<T extends RuntimeProvider>(result: { providers: T[] }) {
  await modelsDevCatalog.ensureLoaded();
  return {
    ...result,
    providers: result.providers.map((provider) => enrichProvider(provider)),
  };
}

type SessionCapabilityDefaults = {
  defaultProviderId?: string;
  defaultModelId?: string;
};

async function loadSessionCapabilityDefaults(): Promise<SessionCapabilityDefaults> {
  if (!host) return {};
  try {
    const settings = await host.call<{
      defaultProviderId?: string;
      defaultModelId?: string;
    }>("settings.get");
    return {
      defaultProviderId: settings?.defaultProviderId,
      defaultModelId: settings?.defaultModelId,
    };
  } catch {
    return {};
  }
}

async function sessionCapabilityContext() {
  const [providers, defaults] = await Promise.all([
    listRuntimeProviders(),
    loadSessionCapabilityDefaults(),
  ]);
  return { providers, defaults };
}

function resolveSessionCapabilityTarget(
  session: RuntimeSession,
  providers: readonly RuntimeProvider[],
  defaults?: SessionCapabilityDefaults,
): { provider: RuntimeProvider; modelId: string } | null {
  const pinnedProvider = session.providerId
    ? providers.find((item) => item.id === session.providerId)
    : undefined;
  const provider =
    pinnedProvider ||
    (defaults?.defaultProviderId
      ? providers.find((item) => item.id === defaults.defaultProviderId)
      : undefined);
  if (!provider) return null;
  const pinnedModelId = pinnedProvider && session.modelId ? session.modelId : undefined;
  const inheritedModelId =
    provider.id === defaults?.defaultProviderId ? defaults.defaultModelId : undefined;
  const modelId =
    pinnedModelId ||
    inheritedModelId ||
    provider.models?.[0]?.id ||
    provider.defaultModelId;
  if (!modelId) return null;
  return { provider, modelId };
}

function enrichSession<T extends RuntimeSession>(
  session: T,
  providers: readonly RuntimeProvider[],
  defaults?: SessionCapabilityDefaults,
): T & ThinkingCapabilities & { supportsVision: boolean } {
  const target = resolveSessionCapabilityTarget(session, providers, defaults);
  if (!target) {
    return {
      ...session,
      supportsReasoning: false,
      supportsVision: false,
      supportedThinkingLevels: ["off"],
    };
  }
  const { provider, modelId } = target;
  const storedModel = bindingForModel(provider, modelId);
  const modelsDevModel = modelsDevModelFor(provider, modelId);
  const modelConfig = modelConfigWithBinding(
    modelsDevModel
      ? modelConfigFromModelsDev(modelsDevModel, provider.baseUrl)
      : genericModelConfig(modelId, provider.baseUrl ?? ""),
    storedModel,
  );
  return {
    ...session,
    ...capabilitiesFromModelConfig(modelConfig),
    supportsVision: visionFromModelConfig(modelConfig),
  };
}

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
  let projectMemory: string | undefined;
  if (projectPath) {
    try {
      const result = await host.call<{ memory?: { content?: string } }>(
        "project.memory.get",
        { path: projectPath },
      );
      const content = result.memory?.content?.trim();
      if (content) projectMemory = content;
    } catch {
      // Project memory is best effort; it must never prevent a session launch.
    }
  }
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
      projectMemory,
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

async function listRuntimeProviders(includeDisabled = true) {
  if (!host) throw new Error("host unavailable");
  const result = await host.call<{ providers: RuntimeProvider[] }>(
    "providers.list",
    { includeDisabled },
  );
  // Model capability enrichment is synchronous after this one process-scoped
  // load. A version change triggers one remote refresh; otherwise the local
  // api.json snapshot is reused.
  await modelsDevCatalog.ensureLoaded();
  return result.providers;
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

async function ensureWindow(): Promise<boolean> {
  if (windowCreationPromise) {
    await windowCreationPromise;
    return true;
  }
  if (mainWindow && !mainWindow.isDestroyed()) return false;

  const creation = createWindow();
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

function importSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    typeof source !== "string" ||
    !IMPORT_SOURCES.has(source as ExternalSource) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return `${source}:${externalId}`;
}

function modelConfigSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    !isModelConfigImportSource(source) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return modelConfigImportKey(source, externalId);
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

async function createWindow() {
  notificationViewingSessionId = null;
  requestedWorkPanelReservation = 0;
  workPanelReservation = emptyWorkPanelReservationState();
  workPanelDisplayKey = null;
  workPanelBaseBounds = null;
  workPanelLastAppliedBounds = null;
  expectedWorkPanelBounds = null;
  workPanelUserMovePending = false;
  workPanelNativeResizeActive = false;
  if (workPanelChatResizeTimer) clearTimeout(workPanelChatResizeTimer);
  workPanelChatResizeTimer = null;
  workPanelChatResizeActive = false;
  setWorkPanelChatWidthForWindow = null;
  const savedState = await readWindowState(
    dataDir,
    WINDOW_MIN_WIDTH,
    WINDOW_MIN_HEIGHT,
  );
  mainWindow = new BrowserWindow({
    ...(savedState ?? { width: 1200, height: 800 }),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: APP_NAME,
    show: false,
    // Keep native edge/corner resizing explicit. Frameless chrome owns the
    // titlebar only; the OS remains responsible for the resize hit regions.
    resizable: true,
    // One frameless look everywhere: macOS keeps inset traffic lights;
    // Windows/Linux hide native chrome entirely — the renderer draws its
    // own Codex-style window controls (see WindowControls.tsx).
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 16 },
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          transparent: true,
          backgroundColor: "#00000000",
        }
      : {
          frame: false,
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff",
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Preload runs in a sandbox and cannot import Electron's main-only `app`
      // module. Pass the display locale at process creation so it remains
      // available synchronously before the renderer's first paint.
      additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
    },
  });
  const window = mainWindow;
  const initialBounds = window.getBounds();
  workPanelBaseBounds = savedState ? { ...savedState } : { ...initialBounds };
  workPanelLastAppliedBounds = { ...initialBounds };
  resetMenuRendererReady(window);
  const isLiveWindow = () =>
    mainWindow === window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed();

  // Keep the macOS traffic-light minimize tray-resident. Windows/Linux
  // minimize actions use Electron's native transition so the OS keeps the
  // ordinary taskbar entry available for restore. Close-to-tray remains an
  // explicit close behavior handled below.
  window.on("minimize", () => {
    if (quitting || !tray || process.platform !== "darwin") return;
    window.hide();
  });
  let workPanelReconcileTimer: NodeJS.Timeout | null = null;
  const scheduleWorkPanelReservation = () => {
    if (workPanelReconcileTimer) clearTimeout(workPanelReconcileTimer);
    workPanelReconcileTimer = setTimeout(() => {
      workPanelReconcileTimer = null;
      if (isLiveWindow()) applyWorkPanelReservation();
    }, 0);
  };

  type NativeWorkPanelResize = {
    baseBounds: WindowBounds;
    initialBounds: WindowBounds;
    settleTimer: NodeJS.Timeout | null;
  };
  let nativeWorkPanelResize: NativeWorkPanelResize | null = null;

  const sendWorkPanelResize = (
    phase: "preview" | "commit",
    panelWidth: number,
  ) => {
    if (!isLiveWindow()) return;
    window.webContents.send(IPC.event.windowWorkPanelResize, {
      phase,
      panelWidth,
    });
  };

  const nativePanelWidth = (bounds: WindowBounds, baseBounds: WindowBounds) =>
    Math.max(
      WORK_PANEL_MIN_WIDTH,
      Math.min(WORK_PANEL_MAX_WIDTH, bounds.width - baseBounds.width),
    );

  const syncNativeWorkPanelResize = (phase: "preview" | "commit") => {
    const state = nativeWorkPanelResize;
    if (!state || !isLiveWindow()) return;
    const currentBounds = window.getBounds();
    const panelWidth = nativePanelWidth(currentBounds, state.baseBounds);
    requestedWorkPanelReservation = panelWidth;
    workPanelReservation = {
      width: Math.max(0, currentBounds.width - state.baseBounds.width),
      xOffset: currentBounds.x - state.baseBounds.x,
    };
    workPanelLastAppliedBounds = { ...currentBounds };
    sendWorkPanelResize(phase, panelWidth);
    return panelWidth;
  };

  const finishNativeWorkPanelResize = () => {
    const state = nativeWorkPanelResize;
    if (!state || !isLiveWindow()) return;
    nativeWorkPanelResize = null;
    workPanelNativeResizeActive = false;
    if (state.settleTimer) clearTimeout(state.settleTimer);

    const currentBounds = window.getBounds();
    const panelWidth = nativePanelWidth(currentBounds, state.baseBounds);
    const nextBaseBounds: WindowBounds = {
      x: state.baseBounds.x + currentBounds.x - state.initialBounds.x,
      y: state.baseBounds.y + currentBounds.y - state.initialBounds.y,
      width: state.baseBounds.width,
      height: Math.max(
        0,
        state.baseBounds.height + currentBounds.height - state.initialBounds.height,
      ),
    };
    workPanelBaseBounds = nextBaseBounds;
    workPanelLastAppliedBounds = { ...currentBounds };
    const display = screen.getDisplayMatching(currentBounds);
    workPanelDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    requestedWorkPanelReservation = panelWidth;
    workPanelReservation = {
      width: Math.max(0, currentBounds.width - nextBaseBounds.width),
      xOffset: currentBounds.x - nextBaseBounds.x,
    };
    const minimumWidth = Math.max(
      WINDOW_MIN_WIDTH,
      Math.min(display.workArea.width, WINDOW_MIN_WIDTH + panelWidth),
    );
    window.setMinimumSize(minimumWidth, WINDOW_MIN_HEIGHT);
    sendWorkPanelResize("commit", panelWidth);
  };

  const armNativeWorkPanelResizeFinish = () => {
    if (!nativeWorkPanelResize) return;
    if (nativeWorkPanelResize.settleTimer) {
      clearTimeout(nativeWorkPanelResize.settleTimer);
    }
    nativeWorkPanelResize.settleTimer = setTimeout(() => {
      nativeWorkPanelResize = nativeWorkPanelResize
        ? { ...nativeWorkPanelResize, settleTimer: null }
        : null;
      finishNativeWorkPanelResize();
    }, WORK_PANEL_NATIVE_RESIZE_SETTLE_MS);
  };

  const beginNativeWorkPanelResize = (baseBoundsOverride?: WindowBounds) => {
    if (
      nativeWorkPanelResize ||
      requestedWorkPanelReservation <= 0 ||
      window.isFullScreen() ||
      window.isMaximized()
    ) {
      return nativeWorkPanelResize;
    }
    const currentBounds = window.getBounds();
    const baseBounds = baseBoundsOverride
      ? { ...baseBoundsOverride }
      : workPanelBaseBounds
        ? { ...workPanelBaseBounds }
        : baseWindowBounds(currentBounds, workPanelReservation);
    nativeWorkPanelResize = {
      baseBounds,
      initialBounds: { ...currentBounds },
      settleTimer: null,
    };
    workPanelNativeResizeActive = true;
    // Let the right edge reach the panel minimum while the base chat width
    // remains fixed. The normal minimum is restored after the gesture settles.
    window.setMinimumSize(baseBounds.width + WORK_PANEL_MIN_WIDTH, WINDOW_MIN_HEIGHT);
    return nativeWorkPanelResize;
  };

  const setWorkPanelChatWidth = (requestedWidth: number) => {
    if (
      !isLiveWindow() ||
      requestedWorkPanelReservation <= 0 ||
      window.isFullScreen() ||
      window.isMaximized()
    ) {
      return workPanelBaseBounds?.width ?? WINDOW_MIN_WIDTH;
    }
    markWorkPanelChatResizeActive();
    const currentBounds = window.getBounds();
    const display = screen.getDisplayMatching(currentBounds);
    const transition = classifyDisplayTransition(
      displayWorkAreaKey(display.id, display.workArea),
    );
    const observedBase = observedWorkPanelBaseBounds(currentBounds, transition);
    const baseBounds =
      transition === "user-moved"
        ? clampBoundsOriginToWorkArea(observedBase, display.workArea)
        : observedBase;
    workPanelBaseBounds = baseBounds;
    workPanelDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    if (transition === "user-moved") workPanelUserMovePending = false;
    const next = planWorkPanelChatResize({
      baseBounds,
      workArea: display.workArea,
      reservationWidth: workPanelReservation.width,
      requestedWidth,
    });
    const minimumWidth = Math.max(
      WINDOW_MIN_WIDTH,
      Math.min(display.workArea.width, WINDOW_MIN_WIDTH + next.reservation.width),
    );
    if (next.bounds.width < currentBounds.width) {
      window.setMinimumSize(minimumWidth, WINDOW_MIN_HEIGHT);
    }
    expectedWorkPanelBounds = next.bounds;
    window.setBounds(next.bounds, false);
    if (next.bounds.width >= currentBounds.width) {
      window.setMinimumSize(minimumWidth, WINDOW_MIN_HEIGHT);
    }
    const appliedBounds = window.getBounds();
    expectedWorkPanelBounds = appliedBounds;
    workPanelLastAppliedBounds = { ...appliedBounds };
    workPanelBaseBounds = baseWindowBounds(appliedBounds, next.reservation);
    workPanelReservation = {
      width: Math.max(0, appliedBounds.width - workPanelBaseBounds.width),
      xOffset: appliedBounds.x - workPanelBaseBounds.x,
    };
    return workPanelBaseBounds.width;
  };
  setWorkPanelChatWidthForWindow = setWorkPanelChatWidth;

  window.on("will-resize", (event, newBounds, details) => {
    if (workPanelChatResizeActive) return;
    if (!isWorkPanelOuterResizeEdge(details?.edge)) return;
    const currentBounds = window.getBounds();
    const state = beginNativeWorkPanelResize(
      observedWorkPanelBaseBounds(currentBounds, "none"),
    );
    if (!state) return;
    const rawPanelWidth = newBounds.width - state.baseBounds.width;
    const panelWidth = nativePanelWidth(newBounds, state.baseBounds);
    if (rawPanelWidth !== panelWidth) {
      event.preventDefault();
      const display = screen.getDisplayMatching(newBounds);
      const next = planWorkPanelReservation({
        baseBounds: state.baseBounds,
        workArea: display.workArea,
        requestedWidth: panelWidth,
      });
      expectedWorkPanelBounds = next.bounds;
      window.setBounds(next.bounds, false);
    }
    requestedWorkPanelReservation = panelWidth;
    sendWorkPanelResize("preview", panelWidth);
    armNativeWorkPanelResizeFinish();
  });

  const observeNativeWorkPanelResize = () => {
    if (workPanelChatResizeActive) return;
    if (nativeWorkPanelResize) {
      syncNativeWorkPanelResize("preview");
      armNativeWorkPanelResizeFinish();
      return;
    }
    // Electron exposes `will-resize` on macOS and Windows. On Linux, retain
    // the same ownership using the pointer's right-edge position as the
    // narrow fallback available to the main process.
    if (requestedWorkPanelReservation > 0) {
      const bounds = window.getBounds();
      const cursor = screen.getCursorScreenPoint();
      if (Math.abs(cursor.x - (bounds.x + bounds.width)) <= 12) {
        beginNativeWorkPanelResize();
        syncNativeWorkPanelResize("preview");
        armNativeWorkPanelResizeFinish();
        return;
      }
    }
    scheduleBoundsCheck();
  };
  window.on("resized", armNativeWorkPanelResizeFinish);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("did-start-loading", () => {
    notificationViewingSessionId = null;
    if (mainWindow === window) resetMenuRendererReady(window);
  });
  window.webContents.on("render-process-gone", () => {
    notificationViewingSessionId = null;
  });

  // Devtools shortcut, gated on developer mode. Frameless windows get no
  // default binding, and Windows/Linux run with the application menu set to
  // null, so F12 is wired here; macOS additionally inherits Cmd+Alt+I from
  // the View menu role (see application-menu.ts).
  window.webContents.on("before-input-event", (event, input) => {
    const isPluginLauncherChord =
      process.platform === "win32" &&
      pluginLauncherBinding === "Alt+Space" &&
      input.type === "keyDown" &&
      input.code === "Space" &&
      input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift;
    if (isPluginLauncherChord) {
      // Keep a focused-window fallback if the host's Windows hook could not
      // be installed. The frameless shell has no system menu of its own.
      event.preventDefault();
      void showPluginLauncher();
      return;
    }
    if (input.type !== "keyDown" || !developerMode) return;
    // `code` rather than `key`: Option+I on macOS produces a dead key.
    const isDevToolsChord =
      input.code === "F12" ||
      (process.platform !== "darwin" &&
        input.code === "KeyI" &&
        input.control &&
        input.shift);
    if (!isDevToolsChord) return;
    event.preventDefault();
    if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    else window.webContents.openDevTools({ mode: "detach" });
  });

  // Fullscreen hides the macOS traffic lights; the renderer shifts its
  // titlebar controls left to reclaim the space.
  const sendFullScreen = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.event.windowFullScreen, {
      fullScreen: window.isFullScreen(),
    });
  };
  window.on("enter-full-screen", sendFullScreen);
  window.on("leave-full-screen", () => {
    sendFullScreen();
    scheduleWorkPanelReservation();
  });
  window.webContents.on("did-finish-load", sendFullScreen);

  const sendMaximized = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.event.windowMaximized, {
      maximized: window.isMaximized(),
    });
  };
  // Custom window controls (Windows/Linux) need maximize state to swap the
  // maximize/restore glyph.
  if (process.platform !== "darwin") {
    window.on("maximize", sendMaximized);
    // Native-runner E2E fixture: establish the initial native state before
    // the renderer mounts, then let WindowControls query it through IPC.
    if (process.env.PI_DESKTOP_START_MAXIMIZED === "1") window.maximize();
  }
  window.on("unmaximize", () => {
    if (process.platform !== "darwin") sendMaximized();
    scheduleWorkPanelReservation();
  });

  const reconcileWorkPanelDisplay = () => {
    if (!isLiveWindow()) return;
    const display = screen.getDisplayMatching(window.getBounds());
    const nextDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    if (nextDisplayKey === workPanelDisplayKey) return;
    scheduleWorkPanelReservation();
  };

  // A native `move` stream is a drag in progress. Re-planning bounds mid-drag
  // fights the window server and lands as a jump on pointer release, so the
  // move path only marks the user-move window and defers reconciliation until
  // the stream goes quiet (D263, issue #18).
  //
  // The retire deadline only bounds how long an unconsumed marker can linger;
  // it never decides attribution, which the flag itself owns.
  const WORK_PANEL_USER_MOVE_RETIRE_MS = 2000;
  let workPanelSettleExpiryTimer: NodeJS.Timeout | null = null;
  const WORK_PANEL_MOVE_SETTLE_MS = 220;
  let workPanelMoveSettleTimer: NodeJS.Timeout | null = null;
  const noteUserWindowMove = () => {
    if (!isLiveWindow()) return;
    const currentBounds = window.getBounds();
    if (
      expectedWorkPanelBounds &&
      windowBoundsEqual(currentBounds, expectedWorkPanelBounds)
    ) {
      expectedWorkPanelBounds = null;
      return;
    }
    expectedWorkPanelBounds = null;
    workPanelUserMovePending = true;
    if (workPanelMoveSettleTimer) clearTimeout(workPanelMoveSettleTimer);
    workPanelMoveSettleTimer = setTimeout(() => {
      workPanelMoveSettleTimer = null;
      reconcileWorkPanelDisplay();
      // The flag must outlive reconciliation far enough for the debounced state
      // save to still see the drag, but it must not survive into a later,
      // unrelated OS display change. `applyWorkPanelReservation` defers geometry
      // for a maximized or fullscreen window and never consumes the flag, so the
      // save deadline is the backstop that always retires it.
      if (workPanelSettleExpiryTimer) clearTimeout(workPanelSettleExpiryTimer);
      workPanelSettleExpiryTimer = setTimeout(() => {
        workPanelSettleExpiryTimer = null;
        workPanelUserMovePending = false;
      }, WORK_PANEL_USER_MOVE_RETIRE_MS);
    }, WORK_PANEL_MOVE_SETTLE_MS);
  };
  const initialDisplay = screen.getDisplayMatching(window.getBounds());
  workPanelDisplayKey = displayWorkAreaKey(
    initialDisplay.id,
    initialDisplay.workArea,
  );
  // A topology change is the OS acting, not the user dragging. Drop any pending
  // drag attribution first so a display removed right after a move is not
  // mistaken for one (D263).
  const reconcileDisplayTopology = () => {
    workPanelUserMovePending = false;
    reconcileWorkPanelDisplay();
  };
  screen.on("display-metrics-changed", reconcileDisplayTopology);
  screen.on("display-added", reconcileDisplayTopology);
  screen.on("display-removed", reconcileDisplayTopology);

  browserPane.setWindow(window);
  pluginViews.setWindow(window);
  window.on("closed", () => {
    screen.removeListener("display-metrics-changed", reconcileDisplayTopology);
    screen.removeListener("display-added", reconcileDisplayTopology);
    screen.removeListener("display-removed", reconcileDisplayTopology);
    if (nativeWorkPanelResize?.settleTimer) {
      clearTimeout(nativeWorkPanelResize.settleTimer);
    }
    nativeWorkPanelResize = null;
    workPanelNativeResizeActive = false;
    if (workPanelChatResizeTimer) clearTimeout(workPanelChatResizeTimer);
    workPanelChatResizeTimer = null;
    workPanelChatResizeActive = false;
    if (setWorkPanelChatWidthForWindow) setWorkPanelChatWidthForWindow = null;
    if (workPanelReconcileTimer) {
      clearTimeout(workPanelReconcileTimer);
      workPanelReconcileTimer = null;
    }
    if (menuRendererReadyGate?.window === window) {
      menuRendererReadyGate.resolve();
      menuRendererReadyGate = null;
    }
    if (mainWindow !== window) return;
    mainWindow = null;
    browserPane.setWindow(null);
    pluginViews.setWindow(null);
    if (
      process.platform !== "darwin" &&
      pluginLauncherWindow &&
      !pluginLauncherWindow.isDestroyed()
    ) {
      pluginLauncherWindow.close();
    }
  });

  // Block navigation away from the app shell (dev server origin or local file).
  window.webContents.on("will-navigate", (event, url) => {
    const devOrigin = process.env.ELECTRON_RENDERER_URL;
    if (devOrigin && url.startsWith(devOrigin)) return;
    event.preventDefault();
    logger.app("diagnostics", "warn", "blocked navigation attempt", { data: { url } });
  });

  // Codex-like default footprint. CG bounds are truth under Stage Manager.
  const CODEX_BOUNDS = { x: 40, y: 30, width: 1200, height: 800 } as const;
  let boundsGuard = false;
  let boundsTimer: NodeJS.Timeout | null = null;
  let pinUntil = 0;
  let captureViewportOverride = false;
  let lastCgAt = 0;
  let lastCg: { x: number; y: number; width: number; height: number } | null = null;
  let missingCgStreak = 0;
  // The CG helper is dev tooling; without it, CG-based shelf detection must
  // stay inert or every machine would look permanently "shelved".
  const cgHelperPath = "/tmp/pi-window-bounds";
  const cgHelperAvailable = existsSync(cgHelperPath);

  const readCgBounds = (): { x: number; y: number; width: number; height: number } | null => {
    if (!cgHelperAvailable) return null;
    // Cache briefly — Stage Manager checks should not spawn tools every frame.
    if (Date.now() - lastCgAt < 700) return lastCg;
    try {
      const out = execFileSync(cgHelperPath, [String(process.pid)], {
        encoding: "utf8",
        timeout: 800,
      }).trim();
      lastCgAt = Date.now();
      if (!out) {
        lastCg = null;
        return null;
      }
      const [x, y, w, h] = out.split(",").map((n: string) => Number(n));
      if (![x, y, w, h].every((n: number) => Number.isFinite(n))) {
        lastCg = null;
        return null;
      }
      lastCg = { x, y, width: w, height: h };
      return lastCg;
    } catch {
      lastCgAt = Date.now();
      lastCg = null;
      return null;
    }
  };

  const ensureStableBounds = (force = false) => {
    if (
      !isLiveWindow() ||
      boundsGuard ||
      workPanelChatResizeActive ||
      captureViewportOverride ||
      // Never fight the user's own state: a minimized window stays
      // minimized and a tray-hidden window stays hidden.
      window.isMinimized() ||
      !window.isVisible()
    ) {
      return;
    }
    const electronBounds = window.getBounds();
    const cg = readCgBounds();
    if (!cg && cgHelperAvailable) missingCgStreak += 1;
    else missingCgStreak = 0;
    // Tiny/offscreen CG footprint is Stage Manager shelf. Missing CG alone is not
    // conclusive (alwaysOnTop can change window layer); require a short streak.
    const shelved =
      (!!cg && (cg.width < 500 || cg.height < 400 || cg.x < -40)) ||
      (!cg && cgHelperAvailable && missingCgStreak >= 3);
    const electronTiny =
      electronBounds.width < 500 || electronBounds.height < 400;
    if (!force && !shelved && !electronTiny) return;

    boundsGuard = true;
    try {
      if (window.isMinimized()) window.restore();
      window.setMinimumSize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
      // Prefer normal layer so CG helpers and Stage Manager stay stable.
      window.setAlwaysOnTop(false);
      window.show();
      window.focus();
      window.moveTop();
      if (shelved) {
        window.hide();
        window.setBounds({ ...CODEX_BOUNDS }, false);
        window.show();
      } else {
        window.setBounds({ ...CODEX_BOUNDS }, false);
      }
      window.setSize(CODEX_BOUNDS.width, CODEX_BOUNDS.height, false);
      window.setPosition(CODEX_BOUNDS.x, CODEX_BOUNDS.y, false);
      const restoredBounds = window.getBounds();
      workPanelBaseBounds = { ...restoredBounds };
      workPanelLastAppliedBounds = { ...restoredBounds };
      workPanelReservation = emptyWorkPanelReservationState();
      // A forced recovery is not user intent; drop any pending drag attribution
      // so the reservation replan below is treated as an OS-owned adjustment.
      workPanelUserMovePending = false;
      applyWorkPanelReservation();
      // Brief pin only when actively recovering from a shelf.
      if (shelved || electronTiny) {
        window.setAlwaysOnTop(true, "floating");
        pinUntil = Date.now() + 4000;
      } else {
        pinUntil = 0;
      }
      // bust CG cache after mutation
      lastCgAt = 0;
      console.log("BOUNDS_RESTORE", {
        electron: electronBounds,
        cg,
        shelved,
        afterElectron: window.getBounds(),
        afterCg: readCgBounds(),
      });
    } finally {
      setTimeout(() => {
        boundsGuard = false;
      }, 350);
    }
  };

  const scheduleBoundsCheck = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!isLiveWindow() || workPanelChatResizeActive) return;
    const scheduledBounds = window.getBounds();
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!isLiveWindow()) return;
      // A slow native gesture may emit another resize/move just after the
      // timer was armed. Never restore from a stale snapshot while that is
      // happening; the latest event will arm a fresh settle window.
      if (!windowBoundsEqual(window.getBounds(), scheduledBounds)) {
        scheduleBoundsCheck();
        return;
      }
      ensureStableBounds(false);
    }, WINDOW_BOUNDS_SETTLE_MS);
  };

  window.on("show", () => ensureStableBounds(false));
  window.on("focus", () => ensureStableBounds(false));
  window.on("restore", () => ensureStableBounds(false));
  window.on("resize", observeNativeWorkPanelResize);
  window.on("move", scheduleBoundsCheck);
  window.on("move", noteUserWindowMove);

  // Persist last good user bounds so relaunch restores them.
  let saveTimer: NodeJS.Timeout | null = null;
  const persistNormalWindowState = () => {
    if (
      !isLiveWindow() ||
      boundsGuard ||
      workPanelNativeResizeActive ||
      workPanelChatResizeActive
    ) {
      return;
    }
    const normalBounds = window.getNormalBounds();
    const display = screen.getDisplayMatching(normalBounds);
    const nextDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    const displayTransition = classifyDisplayTransition(nextDisplayKey);
    const observedBase =
      workPanelBaseBounds && workPanelLastAppliedBounds
        ? observedWorkPanelBaseBounds(normalBounds, displayTransition)
        : baseWindowBounds(window.getNormalBounds(), workPanelReservation);
    // Normalize the same way the reservation path does. A maximized or
    // fullscreen window makes `applyWorkPanelReservation` defer geometry, so
    // this can be the first and only consumer of a cross-display drag; without
    // it, a rect straddling the boundary would be what relaunch restores.
    const bounds =
      displayTransition === "user-moved"
        ? clampBoundsOriginToWorkArea(observedBase, display.workArea)
        : observedBase;
    // An OS re-fit keeps the remembered base so a later return to a roomy
    // display restores it. Same-display moves and user cross-display drags are
    // both real intent, so they advance the base and get persisted; otherwise
    // relaunch would reopen the window on the display the user left (D263).
    if (displayTransition !== "os-adjusted") {
      workPanelBaseBounds = bounds;
      workPanelLastAppliedBounds = { ...normalBounds };
      if (displayTransition === "user-moved") {
        workPanelDisplayKey = nextDisplayKey;
        workPanelUserMovePending = false;
      }
    }
    if (bounds.width >= WINDOW_MIN_WIDTH && bounds.height >= WINDOW_MIN_HEIGHT) {
      writeWindowState(dataDir, bounds);
    }
  };
  const scheduleStateSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNormalWindowState();
    }, 600);
  };
  window.on("resize", scheduleStateSave);
  window.on("move", scheduleStateSave);
  window.on("close", (event) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistNormalWindowState();
    // Windows/Linux close-behavior: "tray" hides the window and keeps the
    // app running under the tray icon, "ask" prompts on the first close,
    // and "quit" (plus macOS and explicit-quit closes) falls through to the
    // default close.
    if (
      process.platform === "darwin" ||
      quitting ||
      windowsAllowedToClose.has(window)
    ) {
      return;
    }
    event.preventDefault();
    void (async () => {
      if (closeBehavior === "ask") {
        if (closePromptOpen) return;
        closePromptOpen = true;
        try {
          const choice = await askCloseBehavior(window);
          if (!choice) return; // canceled: keep the window open
          applyCloseBehavior(choice);
        } finally {
          closePromptOpen = false;
        }
      }
      if (closeBehavior === "tray") {
        createTray();
        // The tray is the only way back to a hidden window; if the icon
        // could not be created, fall back to a real quit instead of
        // leaving the app invisible.
        if (tray) {
          window.hide();
          return;
        }
      }
      // "quit" means quit: go through the ordered `before-quit` shutdown
      // rather than relying on `window-all-closed`, which stays silent while
      // the D216 tray is resident. Mark `quitConfirmed` because the user
      // already chose to quit in the close-behavior dialog above.
      quitConfirmed = true;
      windowsAllowedToClose.add(window);
      app.quit();
    })();
  });

  const boundsWatchdog = setInterval(() => {
    if (!isLiveWindow()) {
      clearInterval(boundsWatchdog);
      return;
    }
    const cg = readCgBounds();
    const electronBounds = window.getBounds();
    if (!cg && cgHelperAvailable) missingCgStreak += 1;
    else missingCgStreak = 0;
    const shelved =
      (!!cg && (cg.width < 500 || cg.height < 400 || cg.x < -40)) ||
      (!cg && cgHelperAvailable && missingCgStreak >= 3);
    const electronTiny =
      electronBounds.width < 500 || electronBounds.height < 400;
    if (shelved || electronTiny) {
      ensureStableBounds(true);
      return;
    }
    if (Date.now() > pinUntil) {
      try {
        window.setAlwaysOnTop(false);
      } catch {
        // ignore
      }
    }
  }, 1500);
  window.on("closed", () => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (workPanelMoveSettleTimer) {
      clearTimeout(workPanelMoveSettleTimer);
      workPanelMoveSettleTimer = null;
    }
    if (workPanelSettleExpiryTimer) {
      clearTimeout(workPanelSettleExpiryTimer);
      workPanelSettleExpiryTimer = null;
    }
    clearInterval(boundsWatchdog);
  });

  window.once("ready-to-show", () => {
    if (!isLiveWindow()) return;
    // Capture runs need the deterministic Codex footprint; normal launches
    // must respect restored user bounds and only fix real shelf states.
    ensureStableBounds(process.env.PI_DESKTOP_CAPTURE === "1");
    window.show();
    window.focus();
    // Burst re-assert only while Stage Manager initially settles / shelves us.
    for (const ms of [100, 250, 500, 1000, 2000, 3500, 5000, 8000, 12000]) {
      setTimeout(() => ensureStableBounds(false), ms);
    }
    if (process.env.PI_DESKTOP_CAPTURE === "1") {
      setTimeout(() => {
        void (async () => {
          try {
            if (!mainWindow) return;
            const { writeFileSync } = await import("node:fs");
            const shot = async (name: string) => {
              const img = await mainWindow!.webContents.capturePage();
              writeFileSync(`/tmp/codex-screens/${name}.png`, img.toPNG());
              console.log("CAPTURE", name, img.getSize());
            };
            const clickNav = async (nav: string) => {
              await mainWindow!.webContents.executeJavaScript(
                `document.querySelector('[data-nav="${nav}"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
              );
            };
            const setPage = async (page: string) => {
              await mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.setPage?.(${JSON.stringify(page)})`,
              );
            };
            const setSettingsTab = async (tab: string) => {
              await mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.setSettingsTab?.(${JSON.stringify(tab)})`,
              );
            };
            const setTheme = async (theme: "light" | "dark") => {
              await mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.setThemeAttr?.(${JSON.stringify(theme)})`,
              );
            };
            // Wait until React leaves the starting gate.
            for (let i = 0; i < 40; i++) {
              const state = await mainWindow!.webContents.executeJavaScript(`({
                readyText: document.body?.innerText?.slice(0,80) || "",
                theme: document.documentElement.dataset.theme || "",
                hasShell: !!document.querySelector(".app-shell"),
                hasSidebar: !!document.querySelector(".sidebar, .sidebar-rail"),
                sidebarClass: document.querySelector(".sidebar, .sidebar-rail")?.className || "",
                navCount: document.querySelectorAll("[data-nav]").length,
              })`);
              console.log("CAPTURE_STATE", i, state);
              if (state.hasShell && state.navCount > 0) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            await mainWindow!.webContents.executeJavaScript(`
              window.__PI_DESKTOP__?.setThemeAttr?.("light");
              window.__PI_DESKTOP__?.setPage?.("chat");
              // ensure expanded sidebar if rail-only
              if (document.querySelector(".sidebar-rail") && !document.querySelector(".sidebar")) {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
              }
            `);
            await new Promise((r) => setTimeout(r, 400));
            try {
              await mainWindow!.webContents.executeJavaScript(
                `window.__PI_CAPTURE__ = 1; void window.__PI_DESKTOP__?.ensureVisualFixtures?.()`,
              );
            } catch {
              // fixtures optional
            }
            // Focused sidebar-status capture: one row per D135 state, in both
            // themes. The status-only mode exits before the broader visual
            // suite and is intended for narrow UI verification.
            if (process.env.PI_DESKTOP_CAPTURE_STATUS_ONLY === "1") {
              if (process.env.PI_DESKTOP_CAPTURE_REDUCED_MOTION === "1") {
                mainWindow!.webContents.debugger.attach("1.3");
                await mainWindow!.webContents.debugger.sendCommand(
                  "Emulation.setEmulatedMedia",
                  {
                    features: [
                      { name: "prefers-reduced-motion", value: "reduce" },
                    ],
                  },
                );
              }
              await mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.ensureVisualFixtures?.()`,
              );
              await new Promise((r) => setTimeout(r, 300));
              const statusFixture = await mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.seedSidebarStatuses?.()`,
              );
              const probeStatuses = async (theme: "light" | "dark") => {
                await setTheme(theme);
                await new Promise((r) => setTimeout(r, 350));
                const probe = await mainWindow!.webContents.executeJavaScript(`(() => ({
                  theme: document.documentElement.dataset.theme,
                  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                  rows: [...document.querySelectorAll('.thread-item-status')].map((status) => {
                    const row = status.closest('.thread-item');
                    const rect = status.getBoundingClientRect();
                    const before = getComputedStyle(status, '::before');
                    return {
                      state: [...status.classList].find((name) => name !== 'thread-item-status'),
                      label: status.getAttribute('aria-label'),
                      color: getComputedStyle(status).color,
                      fill: before.backgroundColor,
                      animation: before.animationName,
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                      rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
                    };
                  }),
                }))()`);
                console.log("SIDEBAR_STATUS_PROBE", probe);
                await shot(`pi-sidebar-status-${theme}`);
              };
              console.log("SIDEBAR_STATUS_FIXTURE", statusFixture);
              await probeStatuses("light");
              await probeStatuses("dark");
              console.log("CAPTURE_STATUS_DONE");
              app.quit();
              return;
            }
            // Provider fixture so settings/model-picker scenes have content.
            try {
              const existing = await host?.call<{ providers?: unknown[] }>(
                "providers.list",
                { includeDisabled: true },
              );
              if (host && (existing?.providers?.length ?? 0) === 0) {
                await host.call("providers.create", {
                  name: "OJ Gateway",
                  vendorKey: "custom",
                  type: "openai_compatible",
                  protocol: "openai_compatible",
                  baseUrl: "https://api.oj.ink/v1",
                  authKind: "api_key_and_base_url",
                  defaultModelId: "mimo-v2.5",
                  secretValue: "sk-capture-fixture",
                  apiStyle: "chat_completions",
                });
                await mainWindow!.webContents.executeJavaScript(
                  `void window.__PI_DESKTOP__?.refreshProviders?.()`,
                );
                await new Promise((r) => setTimeout(r, 300));
              }
            } catch {
              // provider fixture optional
            }
            await new Promise((r) => setTimeout(r, 500));
            // Prefer a titled empty recent (Codex gold selects a real title, not "New task").
            try {
              await mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const items = [...document.querySelectorAll('.thread-item .thread-item-main, .thread-item-main, .thread-item')];
                  const prefer =
                    items.find((el) => /同步代码/.test(el.textContent || '')) ||
                    items.find((el) => !/新\s*建\s*任\s*务|New task|未命名/i.test(el.textContent || ''));
                  if (prefer) prefer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                })()
              `);
              await new Promise((r) => setTimeout(r, 450));
            } catch {
              await clickNav("new-task");
              await new Promise((r) => setTimeout(r, 500));
            }
            try {
              if (mainWindow!.isMinimized()) mainWindow!.restore();
              mainWindow!.show();
              mainWindow!.focus();
              mainWindow!.moveTop();
            } catch {
              // ignore
            }
            await new Promise((r) => setTimeout(r, 350));
            // Composer visibility probe (empty draft must not collapse)
            const composerProbe = await mainWindow!.webContents.executeJavaScript(`(() => { const ta=document.querySelector("textarea.composer-input"); if(!ta) return null; const r=ta.getBoundingClientRect(); return {value:ta.value, ph:ta.placeholder, h:ta.offsetHeight, y:Math.round(r.y)}; })()`);
            console.log("COMPOSER_PROBE", composerProbe);
            await shot("pi-final");
            // Work panel scenes are opened by simulated artifacts; production
            // exposes no empty/manual panel entry point (D119). The panels need
            // an active workspace, so switch to a project-scoped session first —
            // otherwise every panel renders its "open a project" empty state.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const scoped = document.querySelector(
                  "[data-sidebar-project-group] .thread-item-main, [data-sidebar-project-group] .thread-item",
                );
                scoped?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 700));
            // No artifact has run yet, so this session's panel context is
            // empty — the one moment in the suite where the no-resource body
            // and its tool list are on screen (D224). Photograph it in both
            // themes before the artifact scenes create tabs.
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.openWorkPanel()`,
            );
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-empty");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-panel-empty-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 300));
            const openPanelArtifact = (kind: string, resource?: string) =>
              mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.openWorkPanelArtifact(${JSON.stringify(kind)}, ${JSON.stringify(resource)})`,
              );
            await openPanelArtifact("review");
            // The Review tab reads the session transcript, so without a change
            // fixture every review scene would shoot the empty state.
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedReviewChanges?.(4)`,
            );
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-review");
            // Same rows in the transcript: tool activity is collapsed by
            // default, so open every group, then expand one row's diff.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                for (const header of document.querySelectorAll(".tool-activity-header")) {
                  if (header.getAttribute("aria-expanded") !== "true") {
                    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                  }
                }
              })()
            `);
            await new Promise((r) => setTimeout(r, 400));
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = document.querySelectorAll(
                  ".thread-content .review-change-card-header",
                );
                const row = rows[Math.max(0, rows.length - 2)];
                row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                row?.scrollIntoView({ block: "center" });
              })()
            `);
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-review-rows");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("dark")`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-review-rows-dark");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("light")`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedReviewChanges?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // A run row keeps its command in the head and only its output in the
            // body (D226). Seed one row per state, open the activity groups, and
            // hover the open row so its copy control and caret are on screen.
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedRunRows?.(3)`,
            );
            await new Promise((r) => setTimeout(r, 400));
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                for (const header of document.querySelectorAll(".tool-activity-header")) {
                  if (header.getAttribute("aria-expanded") !== "true") {
                    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                  }
                }
              })()
            `);
            await new Promise((r) => setTimeout(r, 400));
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const row = document.querySelector(
                  ".tool-row.status-success .tool-row-header",
                );
                row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                // The failed row sits above it and opens itself, so framing from
                // there catches every outcome the head can state (D227).
                document
                  .querySelector(".tool-row.status-error")
                  ?.scrollIntoView({ block: "start" });
              })()
            `);
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-run-rows");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("dark")`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-run-rows-dark");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("light")`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedRunRows?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // Every delegation is a card, a lone one included: seed one `Task`
            // and a two-`Task` fan-out so the scene shows the two read alike.
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedDelegationRows?.(3)`,
            );
            await new Promise((r) => setTimeout(r, 400));
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                for (const header of document.querySelectorAll(".tool-activity-header")) {
                  if (header.getAttribute("aria-expanded") !== "true") {
                    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                  }
                }
                document
                  .querySelector(".tool-activity-group.has-subagents")
                  ?.scrollIntoView({ block: "start" });
              })()
            `);
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-delegation-cards");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("dark")`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-delegation-cards-dark");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("light")`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedDelegationRows?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await openPanelArtifact("browser");
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-panel-browser");
            const probeWorkPanelNewPage = async (scene: string) => {
              const probe = await mainWindow!.webContents.executeJavaScript(`(() => {
                const blank = document.querySelector('[data-testid="work-panel-empty"]');
                const add = document.querySelector('.work-panel-new-tab');
                return {
                  scene: ${JSON.stringify(scene)},
                  viewport: { width: innerWidth, height: innerHeight },
                  blankPage: Boolean(blank),
                  launcherRows: blank?.querySelectorAll('.work-panel-launcher-row').length ?? 0,
                  popupCount: blank?.querySelectorAll('[role="menu"]').length ?? 0,
                  addHasPopup: add?.hasAttribute('aria-haspopup') ?? false,
                };
              })()`);
              console.log("WORK_PANEL_NEW_PAGE_PROBE", probe);
              if (!probe?.blankPage || probe.launcherRows < 1 || probe.popupCount || probe.addHasPopup) {
                throw new Error(`work-panel blank page contract failed in ${scene}`);
              }
            };
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.openNewWorkPanelTab?.()`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-panel-new");
            await probeWorkPanelNewPage("new-page");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-panel-new-dark");
            await probeWorkPanelNewPage("new-page-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            await mainWindow!.webContents.executeJavaScript(`
              document.querySelector('[data-work-panel-launcher-item="pi.browser/browser"]')?.dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
              )
            `);
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-browser-from-new");
            await openPanelArtifact("file", "apps/desktop/src/App.tsx");
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-files");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-panel-files-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            const probeWorkPanelHeader = async (scene: string) => {
              const probe = await mainWindow!.webContents.executeJavaScript(`(() => {
                const rectFor = (selector) => {
                  const element = document.querySelector(selector);
                  if (!element) return null;
                  const rect = element.getBoundingClientRect();
                  return {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                  };
                };
                const add = rectFor('.work-panel-new-tab');
                const toggle = rectFor('.app-work-panel-toggle');
                const header = rectFor('.work-panel-header');
                return {
                  scene: ${JSON.stringify(scene)},
                  viewport: { width: innerWidth, height: innerHeight },
                  header,
                  add,
                  toggle,
                  gap: add && toggle ? toggle.left - add.right : null,
                  overlaps: add && toggle
                    ? add.left < toggle.right && add.right > toggle.left &&
                      add.top < toggle.bottom && add.bottom > toggle.top
                    : null,
                };
              })()`);
              console.log("WORK_PANEL_HEADER_PROBE", probe);
              if (probe?.overlaps) {
                throw new Error(`work-panel header controls overlap in ${scene}`);
              }
              if (probe?.gap != null && probe.gap < 24) {
                throw new Error(`work-panel header controls are too close in ${scene}`);
              }
            };
            await probeWorkPanelHeader("browser-from-new");
            // Exercise the smallest supported shell with the smallest panel
            // width. The notification-only 420px scene below intentionally
            // tests a clipped surface, so it is not suitable for this header
            // geometry check.
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setWorkPanelWidth?.(244)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            captureViewportOverride = true;
            try {
              mainWindow!.setMinimumSize(1040, 700);
              mainWindow!.setSize(1040, 700, false);
              await new Promise((r) => setTimeout(r, 350));
              await probeWorkPanelHeader("minimum-supported");
              await shot("pi-panel-minimum-supported");
            } finally {
              mainWindow!.setSize(CODEX_BOUNDS.width, CODEX_BOUNDS.height, false);
              mainWindow!.setMinimumSize(
                workPanelMinimumWindowWidth(),
                WINDOW_MIN_HEIGHT,
              );
              captureViewportOverride = false;
            }
            await new Promise((r) => setTimeout(r, 250));
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.collapseWorkPanel()`,
            );
            await new Promise((r) => setTimeout(r, 300));
            // Open composer + menu for chrome parity proof.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const btn = document.querySelector('.composer-model-thinking button');
                if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-model-menu");
            await mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            // Composer autocomplete scenes (D123–D125): "/" command menu and
            // "@" file menu. React's controlled textarea needs the native
            // value setter + input event to register the draft.
            const setComposerDraft = (draft: string) =>
              mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const ta = document.querySelector("textarea.composer-input");
                  if (!ta) return false;
                  ta.focus();
                  const set = Object.getOwnPropertyDescriptor(
                    HTMLTextAreaElement.prototype,
                    "value",
                  ).set;
                  set.call(ta, ${JSON.stringify(draft)});
                  ta.dispatchEvent(new Event("input", { bubbles: true }));
                  return true;
                })()
              `);
            await setComposerDraft("/");
            await new Promise((r) => setTimeout(r, 450));
            const slashProbe = await mainWindow!.webContents.executeJavaScript(
              `(() => { const m = document.querySelector(".composer-autocomplete"); return m ? { rows: m.querySelectorAll(".composer-ac-item").length, groups: [...m.querySelectorAll(".composer-model-group-label")].map((g) => g.textContent) } : null; })()`,
            );
            console.log("COMPOSER_AC_SLASH", slashProbe);
            await shot("pi-composer-slash");
            await setComposerDraft("@");
            await new Promise((r) => setTimeout(r, 450));
            const atProbe = await mainWindow!.webContents.executeJavaScript(
              `(() => { const m = document.querySelector(".composer-autocomplete"); return m ? { rows: m.querySelectorAll(".composer-ac-item").length, empty: m.querySelector(".composer-model-empty")?.textContent || "" } : null; })()`,
            );
            console.log("COMPOSER_AC_AT", atProbe);
            await shot("pi-composer-at");
            await setComposerDraft("");
            await new Promise((r) => setTimeout(r, 200));
            // Conversation minimap: seed a capture-only transcript, magnify
            // mid-rail (Dock effect + preview popover), then restore.
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedTranscript?.()`,
            );
            await new Promise((r) => setTimeout(r, 600));
            await shot("pi-minimap");
            const minimapProbe = await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rail = document.querySelector(".minimap-rail");
                if (!rail) return null;
                const r = rail.getBoundingClientRect();
                rail.dispatchEvent(new MouseEvent("mousemove", {
                  bubbles: true,
                  clientX: r.left + 10,
                  clientY: r.top + r.height / 2,
                }));
                return { markers: rail.querySelectorAll(".minimap-marker").length };
              })()
            `);
            console.log("MINIMAP_PROBE", minimapProbe);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-minimap-hover");
            await mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedTranscript?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // Notification inbox: mixed status, long title, read state, 99+ badge,
            // both themes, then the responsive fixed-position popover.
            const openNotificationFixture = async () => {
              await mainWindow!.webContents.executeJavaScript(`
                window.__PI_DESKTOP__?.seedNotifications?.(105);
                document.querySelector('.notification-trigger')?.dispatchEvent(
                  new MouseEvent('click', { bubbles: true })
                );
              `);
              // Opening refreshes the durable inbox; reapply the capture-only
              // fixture after that request settles.
              await new Promise((r) => setTimeout(r, 350));
              await mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.seedNotifications?.(105)`,
              );
              await new Promise((r) => setTimeout(r, 150));
            };
            const probeNotificationFixture = async (scene: string) => {
              const probe = await mainWindow!.webContents.executeJavaScript(`(() => {
                const popover = document.querySelector('.notification-popover');
                const title = document.querySelector('.notification-item-title');
                const badge = document.querySelector('.notification-badge');
                if (!popover || !title) return null;
                const rect = popover.getBoundingClientRect();
                const titleStyle = getComputedStyle(title);
                return {
                  scene: ${JSON.stringify(scene)},
                  viewport: { width: innerWidth, height: innerHeight },
                  popover: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                    position: getComputedStyle(popover).position,
                  },
                  withinViewport:
                    rect.left >= 0 && rect.top >= 0 &&
                    rect.right <= innerWidth && rect.bottom <= innerHeight,
                  badge: badge?.textContent?.trim() || '',
                  rowCount: document.querySelectorAll('.notification-item').length,
                  unreadRows: document.querySelectorAll('.notification-item.unread').length,
                  failedRows: document.querySelectorAll('.notification-kind-icon.failed').length,
                  titleTruncated:
                    title.scrollWidth > title.clientWidth &&
                    titleStyle.textOverflow === 'ellipsis',
                };
              })()`);
              console.log("NOTIFICATION_PROBE", probe);
            };
            await setTheme("light");
            await setPage("chat");
            await openNotificationFixture();
            await probeNotificationFixture("light");
            await shot("pi-notifications-light");
            await mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            await setTheme("dark");
            await openNotificationFixture();
            await probeNotificationFixture("dark");
            await shot("pi-notifications-dark");
            await mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            captureViewportOverride = true;
            try {
              mainWindow!.setMinimumSize(420, 640);
              mainWindow!.setSize(420, 760, false);
              await new Promise((r) => setTimeout(r, 250));
              await setTheme("light");
              await openNotificationFixture();
              await probeNotificationFixture("narrow");
              await shot("pi-notifications-narrow");
              await mainWindow!.webContents.executeJavaScript(`
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                window.__PI_DESKTOP__?.seedNotifications?.(0);
              `);
            } finally {
              mainWindow!.setSize(CODEX_BOUNDS.width, CODEX_BOUNDS.height, false);
              mainWindow!.setMinimumSize(
                workPanelMinimumWindowWidth(),
                WINDOW_MIN_HEIGHT,
              );
              captureViewportOverride = false;
            }
            await new Promise((r) => setTimeout(r, 300));
            // Destination + theme captures (robust via __PI_DESKTOP__ hooks).
            await setTheme("dark");
            await setPage("chat");
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-dark-home");
            // Destinations are lazy route chunks; the first visit needs long
            // enough for the chunk to resolve or the shot catches a spinner.
            await setPage("settings");
            await setSettingsTab("projects");
            await new Promise((r) => setTimeout(r, 800));
            await shot("pi-dark-project-archive");
            await setPage("pulls");
            await new Promise((r) => setTimeout(r, 800));
            await shot("pi-dark-pulls");
            await setPage("settings");
            await setSettingsTab("general");
            await new Promise((r) => setTimeout(r, 800));
            await shot("pi-dark-settings");
            await setTheme("light");
            await setPage("pulls");
            await new Promise((r) => setTimeout(r, 600));
            await shot("pi-pulls-live");
            await setSettingsTab("projects");
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-project-archive-live");
            await setPage("scheduled");
            await new Promise((r) => setTimeout(r, 700));
            await shot("pi-scheduled-live");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPlugins?.(4);
               window.__PI_DESKTOP__?.seedExtensions?.(3)`,
            );
            await setPage("plugins");
            await new Promise((r) => setTimeout(r, 350));
            // Mounting the page refreshes the store slice from IPC, which
            // replaces the fixture with the real (near-empty) index; seed again
            // once the mount effect has settled.
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPlugins?.(4)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-live");
            // Disclosed row details: capability, service and permission chips
            // inside the raised detail block (D296).
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const details = document.querySelector('.plugins-row-details');
                if (details) details.open = true;
              })()
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-row-details");
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const details = document.querySelector('.plugins-row-details');
                if (details) details.open = false;
              })()
            `);
            // Row overflow menu on the last row of a group: rows are separate
            // tiles, so this scene guards the menu against the tile below.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = [...document.querySelectorAll('.plugins-row')];
                const last = rows[rows.length - 1];
                last?.scrollIntoView({ block: 'center' });
                const btns = [...(last?.querySelectorAll('.plugins-row-actions .plugins-icon-btn') ?? [])];
                btns[btns.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-row-menu");
            await mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 150));
            // The page's segments, in order: installed, marketplace. (MCP,
            // skills and subagents moved to Settings; their scenes below are
            // shot from there and only reuse this helper's click plumbing.)
            const extTab = async (index: number, settle = 350) => {
              await mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const tabs = [...document.querySelectorAll('.plugins-segment-btn')];
                  tabs[${index}]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                })()
              `);
              await new Promise((r) => setTimeout(r, settle));
            };
            // MCP tab: one row per connection state and per activation state, so
            // the glyph colours and the scope chip are all on screen at once.
            await extTab(1);
            await shot("pi-extensions-mcp");
            // The scope popover has to escape the panel's rounded-corner clip,
            // so it is opened on the last row where a clip would show.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = [...document.querySelectorAll('.ext-row')];
                const last = rows[rows.length - 1];
                last?.scrollIntoView({ block: 'center' });
                last?.querySelector('.scope-chip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  ?? last?.querySelector('.scope-seg:nth-child(2)')
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-scope");
            await mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 150));
            // Editor sheet: transport cards, key/value rows, and the in-sheet
            // scope field that renders in place instead of floating.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                document.querySelector('.ext-section-actions button:last-of-type')
                  ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-mcp-editor");
            await mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 200));
            // Skills tab: the byte counter and the disabled row read differently
            // from the MCP rows, so it gets its own scene.
            await extTab(2);
            await shot("pi-extensions-skills");
            // Subagents tab: the writable registry list, whose rows carry the
            // Task handle, the tinted mutating grants and the shadow/inactive
            // tags, above the read-only effective catalog.
            await extTab(3);
            await shot("pi-extensions-subagents");
            // The read-only half sits below the fold: builtin and project rows,
            // which carry a source tag and a copy action instead of a scope.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = [...document.querySelectorAll('.ext-row')];
                rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-subagents-provided");
            await mainWindow!.webContents.executeJavaScript(
              `document.querySelector('.plugins-page')?.scrollTo(0, 0)`,
            );
            await new Promise((r) => setTimeout(r, 200));
            // Editor sheet: the tool grant sits above the prompt, which is the
            // whole point of the field order, so it needs to be on screen.
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                document.querySelector('.ext-section-actions button:last-of-type')
                  ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-extensions-subagent-editor");
            await mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 200));
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-subagents-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            await extTab(1, 250);
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-mcp-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            // Marketplace tab of the same page (D169 segmented control, fifth
            // since D202).
            await extTab(1, 900);
            await shot("pi-plugins-market");
            // Detail sheet opened from the first card: head, install CTA and
            // the section stack without rules between them (D296).
            await mainWindow!.webContents.executeJavaScript(`
              document.querySelector('.plugins-card-hit')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            `);
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-plugins-sheet");
            await mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // Template picker behind the overflow menu (D171). Selecting a
            // template only sets state, so no folder dialog opens here.
            await extTab(0, 250);
            await mainWindow!.webContents.executeJavaScript(`
              document
                .querySelector('.plugins-menu-wrap .plugins-icon-btn')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-menu");
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const items = [...document.querySelectorAll('.plugins-menu [role="menuitem"]')];
                items[items.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-plugins-template");
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const cancel = document.querySelector('.plugins-modal-actions button');
                cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 200));
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPlugins?.(0);
               window.__PI_DESKTOP__?.seedExtensions?.(0);
               window.__PI_DESKTOP__?.seedPluginThemes?.(2)`,
            );
            await setPage("settings");
            // The general tab carries the theme picker, including plugin themes
            // (D175); earlier scenes leave the sidebar on the archive tab.
            await setSettingsTab("general");
            // Seeding plugin themes activates one of them, which drags the
            // shell dark; the settings tabs are documented in light.
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-live");
            await mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPluginThemes?.(0)`,
            );
            // Dropping the seeded plugin themes re-applies the stored theme,
            // which is still dark from the destination pass; the remaining
            // settings scenes are light so the tabs read as one sequence.
            await setTheme("light");
            // Model configuration tab: vendor accounts, provider cards,
            // defaults, edit dialog. Addressed by tab id — the settings nav
            // has been reordered since this scene was written.
            await setSettingsTab("agent");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-models");
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const edit = [...document.querySelectorAll('.provider-row-actions .provider-icon-btn')][0];
                const add = document.querySelector('.provider-section-head button');
                (edit ?? add)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-provider-dialog");
            await mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            await new Promise((r) => setTimeout(r, 200));
            // Plugins marketplace: the source picker lives beside the catalog,
            // including the custom URL row that only appears for that source.
            await setPage("plugins");
            await mainWindow!.webContents.executeJavaScript(
              `document.querySelector('#plugins-tab-market')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-extensions");
            await mainWindow!.webContents.executeJavaScript(`
              (() => {
                const select = document.querySelector('.plugins-market-settings select');
                if (!select) return;
                const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLSelectElement.prototype, 'value',
                )?.set;
                setter?.call(select, 'custom');
                select.dispatchEvent(new Event('change', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-extensions-custom");
            await setPage("chat");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            const openSearch = () =>
              mainWindow!.webContents.executeJavaScript(`
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
              `);
            const typeSearch = (value: string) =>
              mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const input = document.querySelector(".search-input");
                  if (!input) return;
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    "value",
                  ).set;
                  setter.call(input, ${JSON.stringify(value)});
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                })()
              `);
            const searchKey = (key: string) =>
              mainWindow!.webContents.executeJavaScript(`
                document.querySelector(".search-input")?.dispatchEvent(
                  new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }),
                );
              `);
            await openSearch();
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-search");
            await typeSearch("设计");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-search-query");
            // Settings hits: "主题" resolves to 通用 tab's theme row.
            await typeSearch("主题");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-search-settings");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-search-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            // Page hits: "插件" surfaces the plugins page entry.
            await typeSearch("插件");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-search-pages");
            // Anchor flash: Enter on the 主题 settings hit lands on 基础 and
            // flashes the theme row.
            await typeSearch("主题");
            await new Promise((r) => setTimeout(r, 350));
            await searchKey("ArrowDown");
            await searchKey("Enter");
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-search-anchor");
            // The anchor scene leaves the ⌘K dialog open; dismiss it so the
            // home hero below is unobstructed. The dialog only listens on its
            // own subtree, so close it the way a user does — click the overlay.
            await searchKey("Escape");
            await mainWindow!.webContents.executeJavaScript(`
              document.querySelector(".search-overlay")?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
              );
            `);
            await new Promise((r) => setTimeout(r, 300));
            await setPage("chat");
            await new Promise((r) => setTimeout(r, 250));
            // Empty home hero in both themes — the first surface a new install
            // shows, and the one the README and docs gallery lead with. Shot
            // before the toast stack so the hero stays unobstructed.
            await clickNav("new-task");
            await new Promise((r) => setTimeout(r, 600));
            // Seeding the marketplace earlier raised a toast that outlives the
            // scenes above; clear the viewport so the hero is the only subject.
            const clearToasts = () =>
              mainWindow!.webContents.executeJavaScript(`
                document.querySelectorAll(".toast-dismiss").forEach((button) =>
                  button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
                );
              `);
            await clearToasts();
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-home-light");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-home-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            // Toast stack proof (ToastHost variants) in both themes.
            const raiseToasts = () =>
              mainWindow!.webContents.executeJavaScript(`
                window.__PI_DESKTOP__?.showToast?.("Provider saved", { variant: "success" });
                window.__PI_DESKTOP__?.showToast?.("Reconnecting to local backend…", { variant: "warning" });
                window.__PI_DESKTOP__?.showToast?.("Model request failed: 401 Unauthorized", { variant: "error" });
              `);
            await raiseToasts();
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-toasts-light");
            await setTheme("dark");
            await raiseToasts();
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-toasts-dark");
            await setTheme("light");
            console.log("CAPTURE_DONE");
            await mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            } catch (e) {
            console.error(e);
          }
        })();
      }, 1800);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    if (process.env.PI_DESKTOP_DEVTOOLS === "1") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

const RESTART_WINDOW_MS = 120_000;
const MAX_RESTARTS_PER_WINDOW = 3;
const restartState = {
  host: { count: 0, windowStart: 0 },
  sidecar: { count: 0, windowStart: 0 },
};
type RestartKind = "host" | "sidecar";
const restartInFlight: Record<RestartKind, Promise<void> | null> = {
  host: null,
  sidecar: null,
};

function wireHost(h: HostProcess) {
  h.onNotification((method, params) => {
    // Notifications from a previous host generation must never reach the
    // current plugin/renderer bridge after a restart.
    if (host !== h) return;
    if (method === "permissions.request") {
      logger.app("permission", "info", "permission requested", {
        sessionId: (params as any).sessionId,
        toolCallId: (params as any).toolCallId,
        data: { toolName: (params as any).toolName, risk: (params as any).risk },
      });
      // A delegate's call is already in `activeToolCalls` by the time the host
      // asks: the sidecar forwards `tool_start` before it executes the tool.
      // Without this the dialog would attribute a delegate's write to the main
      // agent, which is the one thing the user must not be confused about.
      const asking = activeToolCalls.get(
        activeToolCallKey(
          (params as any).sessionId,
          (params as any).toolCallId,
        ),
      );
      const envelope: AgentEventEnvelope = {
        sessionId: (params as any).sessionId,
        ts: Date.now(),
        event: {
          type: "tool_permission_request",
          request: {
            requestId: (params as any).requestId,
            sessionId: (params as any).sessionId,
            toolCallId: (params as any).toolCallId,
            toolName: (params as any).toolName,
            argsPreview: (params as any).argsPreview,
            risk: (params as any).risk,
            reason: (params as any).reason,
            ...(asking?.agentName ? { agentName: asking.agentName } : {}),
            ...(asking?.parentToolCallId
              ? { parentToolCallId: asking.parentToolCallId }
              : {}),
          },
        },
      };
      emitAgentEvent(envelope);
    } else if (method === "plugins.execute") {
      // Host dispatches plugin_* and mcp_* tools to us; run them and answer.
      void (async () => {
        const q = params as {
          executionId: string;
          sessionId?: string;
          toolCallId?: string;
          toolName: string;
          args: unknown;
          mode?: string;
        };
        const projectPath = q.sessionId
          ? (sessionProjects.get(q.sessionId) ?? null)
          : null;
        const tool = plugins.getTools().find((t) => t.fullName === q.toolName);
        let payload: Record<string, unknown>;
        if (q.toolName.startsWith("mcp_")) {
          try {
            const result = await userMcp.callTool(q.toolName, q.args, projectPath);
            payload = { executionId: q.executionId, ok: true, content: result ?? null };
          } catch (e) {
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode:
                (e as { errorCode?: string })?.errorCode ?? "TOOL_FAILED",
              content: { error: e instanceof Error ? e.message : String(e) },
            };
          }
        } else if (!tool) {
          payload = {
            executionId: q.executionId,
            ok: false,
            errorCode: "TOOL_NOT_FOUND",
            content: { error: `plugin tool not loaded: ${q.toolName}` },
          };
        } else if (!pluginActiveInProject(tool.pluginId, projectPath)) {
          // The catalog already hid it, but a session assembled before the
          // scope changed can still ask.
          payload = {
            executionId: q.executionId,
            ok: false,
            errorCode: "TOOL_NOT_FOUND",
            content: {
              error: `plugin tool ${q.toolName} is not enabled for this project`,
            },
          };
        } else {
          try {
            let modelKey: string | undefined;
            let thinkingLevel: string | undefined;
            // Host-core sends the session mode; fall back to a session.get
            // call when it is missing (legacy callers). The plugin-runtime
            // uses the mode to enforce plan-safe action restrictions
            // (ADR 0211).
            let sessionMode: "agent" | "plan" | "goal" | undefined;
            const normalizedMode = typeof q.mode === "string" ? q.mode : undefined;
            if (normalizedMode === "agent" || normalizedMode === "plan" || normalizedMode === "goal") {
              sessionMode = normalizedMode;
            } else if (q.sessionId && host) {
              try {
                const detail = await host.call<{
                  session?: {
                    mode?: string;
                    providerId?: string;
                    modelId?: string;
                    thinkingLevel?: string;
                  };
                }>("session.get", { id: q.sessionId });
                const session = detail?.session;
                if (session?.mode === "agent" || session?.mode === "plan" || session?.mode === "goal") {
                  sessionMode = session.mode;
                }
                if (session?.providerId && session?.modelId) {
                  modelKey = `${session.providerId}/${session.modelId}`;
                }
                thinkingLevel = session?.thinkingLevel;
              } catch {
                // Executor identity is best-effort; the tool can still run.
              }
            }
            const result = await tool.execute(q.args, {
              sessionId: q.sessionId,
              mode: sessionMode,
              modelKey,
              thinkingLevel,
            });
            payload = {
              executionId: q.executionId,
              ok: true,
              content: result ?? null,
            };
          } catch (e) {
            const code =
              e && typeof e === "object" && "code" in e && typeof e.code === "string"
                ? e.code
                : "TOOL_FAILED";
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode: code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "TOOL_FAILED",
              content: { error: e instanceof Error ? e.message : String(e) },
            };
          }
        }
        logger.app("plugin", "info", "plugin tool executed", {
          toolCallId: q.toolCallId,
          pluginId: tool?.pluginId,
          data: { toolName: q.toolName, ok: payload.ok === true },
        });
        try {
          await h.call("plugins.resolveExecution", payload);
        } catch (e) {
          logger.app("plugin", "warn", "plugin execution resolve failed", {
            data: String(e),
          });
        }
        for (const toast of plugins.drainToasts()) {
          sendToRenderer(IPC.event.toast, { message: toast });
        }
      })();
    } else if (
      method === "keyboard.shortcut" &&
      process.platform === "win32" &&
      (params as { binding?: unknown })?.binding === "Alt+Space"
    ) {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "Windows global shortcut failed", {
          data: String(error),
        }),
      );
    } else if (method === "plans.changed") {
      sendToRenderer(IPC.event.plansChanged, params);
    }
  });
  h.onExit(({ code, signal, intentional }) => {
    if (host !== h) return;
    logger.flushChild("host");
    host = null;
    if (intentional || quitting) return;
    for (const [executionId, sessionId] of claimedExecutionSessions) {
      if (approvedExecutionIdsBySession.get(sessionId) === executionId) {
        void finishTurn(sessionId, "aborted", "PLAN_EXECUTION_INTERRUPTED");
      }
      void finishApprovedExecution(
        executionId,
        "interrupted",
        "PLAN_EXECUTION_INTERRUPTED",
      );
    }
    logger.app("runtime", "error", "host-core exited unexpectedly", {
      code: ErrorCodes.HOST_UNAVAILABLE,
      data: { exitCode: code, signal },
    });
    sendToRenderer(IPC.event.hostStatus, {
      ok: false,
      component: "host",
      restarting: true,
    });
    void superviseRestart("host");
  });
}

async function startHost(): Promise<void> {
  assertLinuxGlibcSupported();
  const h = new HostProcess(dataDir, (text) => logger.child("host", text));
  wireHost(h);
  host = h;
  try {
    await h.handshake();
    logger.app("runtime", "info", "host-core handshake ok", {
      data: { generation: h.generation },
    });
    void importLegacyScheduled();
    // Drain before the renderer can session.get. Assistant/tool rows live in
    // this outbox until host-core appends them; a cold start that raced the
    // flush showed only user prompts (issue #42 / D327). Boot leaves
    // completed checkpoints in place so this drain can land the finished
    // row first; leftovers are then promoted as complete.
    await persistenceOutbox.flush(() => host);
    try {
      await h.call("session.recoverInflightMessages");
    } catch (error) {
      logger.app("persistence", "warn", "in-flight reply recovery after outbox drain failed", {
        data: String(error),
      });
    }
  } catch (error) {
    if (host === h) host = null;
    logger.flushChild("host");
    await h.dispose();
    throw error;
  }
}

const planUiProbe = createPlanUiProbe({
  getHost: () => host,
  getSidecar: () => sidecar,
  logger,
});

/** Fan an agent event out to the renderer and the headless Agent Host module. */
function emitAgentEvent(envelope: AgentEventEnvelope) {
  agentHostBridge?.ingest(envelope);
  sendToRenderer(IPC.event.agentMessage, envelope);
}

function wireSidecar(s: AgentSidecar) {
  s.onNotification((method, params) => {
    if (method === "agent.event") {
      const envelope = params as AgentEventEnvelope;
      const event = envelope.event;
      if (event.type === "tool_start") {
        logger.app("tool", "info", "tool start", {
          sessionId: envelope.sessionId,
          toolCallId: (event as any).toolCallId,
          data: { toolName: (event as any).toolName },
        });
      } else if (event.type === "tool_end") {
        logger.app("tool", "info", "tool end", {
          sessionId: envelope.sessionId,
          toolCallId: (event as any).toolCallId,
          data: { isError: (event as any).isError === true },
        });
      }
      emitAgentEvent(envelope);
      const persistedMessage = persistAgentEvent(envelope);
      if (persistedMessage) {
        // The renderer may have reloaded while a long-running tool was open.
        // Replay the completed row through the existing message_end contract so
        // it can append the row when the original tool_start is no longer in
        // the in-memory transcript.
        emitAgentEvent({
          ...envelope,
          event: { type: "message_end", message: persistedMessage },
        } satisfies AgentEventEnvelope);
      }
    }
    // permissions.request reaches the renderer once, via wireHost; the
    // sidecar no longer relays it (agent-sidecar.setHost filters it out).
  });
  s.onExit(({ code, signal, intentional, stderrTail }) => {
    if (sidecar !== s) return;
    logger.flushChild("agent");
    sidecar = null;
    if (intentional || quitting) return;
    // A sidecar crash closes live approval waiters before the replacement
    // sidecar starts. This prevents an old renderer response from waking a
    // dead runtime and records the durable turn as interrupted.
    for (const sessionId of [...activeTurns.keys()]) {
      void (async () => {
        const executionId = approvedExecutionIdsBySession.get(sessionId);
        if (host) {
          await host.call("plans.abort", { sessionId }).catch(() => undefined);
        }
        // No final row is coming from a dead sidecar: keep whatever the reply
        // had streamed so far as an aborted transcript row (D299).
        await inflightCheckpointer.flush(sessionId);
        inflightCheckpointer.settle(sessionId);
        await finishTurn(sessionId, "aborted", "PLAN_APPROVAL_INTERRUPTED", {
          recoverInflight: true,
        });
        if (executionId) {
          await finishApprovedExecution(
            executionId,
            "interrupted",
            "PLAN_EXECUTION_INTERRUPTED",
          );
        }
      })();
    }
    for (const [executionId] of claimedExecutionSessions) {
      void finishApprovedExecution(
        executionId,
        "interrupted",
        "PLAN_EXECUTION_INTERRUPTED",
      );
    }
    logger.app("runtime", "error", "agent sidecar exited unexpectedly", {
      data: { exitCode: code, signal, stderrTail },
    });
    sendToRenderer(IPC.event.hostStatus, {
      ok: false,
      component: "sidecar",
      restarting: true,
    });
    void superviseRestart("sidecar");
  });
}

async function startSidecar(): Promise<void> {
  const s = new AgentSidecar((text) => logger.child("agent", text));
  wireSidecar(s);
  s.setProjectInstructionResolver(async ({ projectPath, path }) => {
    // The root is registered by Electron main from the host-owned session
    // record. The sidecar can provide a target path, never an arbitrary root.
    return loadInstructionChain(projectPath, path);
  });
    // Request auth for a vendor account (ADR 0098). The sidecar names a provider
  // row it was launched with; main resolves that row's account and returns a
  // short-lived `ModelAuth`. The refresh token never crosses this boundary.
  s.setTrustedExtensionBridge({
    publishCommands: (params) =>
      agentExtensions.publishCommands(
        String(params.sessionId ?? ""),
        Array.isArray(params.commands) ? (params.commands as any[]) : [],
      ),
    publishDiagnostics: (params) =>
      agentExtensions.publishDiagnostics(
        String(params.sessionId ?? ""),
        Array.isArray(params.diagnostics) ? (params.diagnostics as any[]) : [],
        Array.isArray(params.reports) ? (params.reports as any[]) : [],
      ),
    requestUi: (params) => agentExtensions.requestUi(params as any),
    queuePush: async (params) => {
      if (!agentHostBridge) throw new Error("agent host unavailable");
      return agentHostBridge.queue.push({
        sessionId: String(params.sessionId ?? ""),
        content: String(params.content ?? ""),
        ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}),
      });
    },
    queuePrioritize: async (params) => {
      if (!agentHostBridge) throw new Error("agent host unavailable");
      await agentHostBridge.queue.prioritize(String(params.id ?? ""));
      return { ok: true };
    },
  });
  s.setVendorAuthResolver(async ({ providerId }) =>
    vendorOAuth.resolveAuth(providerId),
  );
  s.setSubagentModelResolver(async (key: string) => {
    const slash = key.indexOf("/");
    if (slash < 1) throw new Error("invalid model key");
    const providerPart = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    if (!modelId) throw new Error("empty model id");

    const allProviders = await listRuntimeProviders(false);
    // Use the same matching logic as resolveSubagentProviders
    const alias = providerPart.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const provider =
      allProviders.find((p) => p.id === providerPart) ||
      allProviders.filter((p) => (p.vendorKey ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") === alias)[0] ||
      allProviders.filter((p) => p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") === alias)[0];
    if (!provider) throw new Error(`no provider matches "${providerPart}"`);

    // Check if the model has availableForSubagents enabled
    const binding = provider.models?.find(
      (m: any) => m.id === modelId || m.id.toLowerCase() === modelId.toLowerCase(),
    );
    if (!binding?.availableForSubagents) {
      throw new Error(
        `model "${modelId}" on provider "${provider.name}" is not enabled for delegation`,
      );
    }

    const isVendorAccount = provider.authKind === OAUTH_AUTH_KIND;
    let apiKey = "";
    if (!isVendorAccount && provider.authKind !== "none") {
      const secret = await host!.call<{ value?: string }>(
        "providers.getSecret",
        { id: provider.id },
      );
      apiKey = secret?.value ?? "";
      if (!apiKey) throw new Error(`provider "${provider.name}" has no API key`);
    }

    await modelsDevCatalog.ensureLoaded();
    let catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0];
    if (isVendorAccount) {
      const vendorBinding = await vendorOAuth.bindingFor(provider.id, modelId);
      if (!vendorBinding) throw new Error(`vendor "${provider.name}" does not offer "${modelId}"`);
      catalogModelConfig =
        vendorBinding.modelConfig ??
        genericModelConfig(modelId, vendorBinding.baseUrl ?? provider.baseUrl ?? "");
    } else {
      const model = modelsDevCatalog.findModel({
        vendorKey: provider.vendorKey,
        baseUrl: provider.baseUrl,
        modelId,
      });
      catalogModelConfig = model
        ? modelConfigFromModelsDev(model, provider.baseUrl)
        : genericModelConfig(modelId, provider.baseUrl ?? "");
    }
    const { modelConfig, capabilities } = effectiveSubagentModelConfig(
      provider,
      modelId,
      catalogModelConfig,
    );

    return {
      id: provider.id,
      name: provider.name,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      modelId,
      apiKey,
      ...(provider.authKind ? { authKind: provider.authKind } : {}),
      ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
      supportsReasoning: capabilities.supportsReasoning,
      supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
      ...(modelConfig ? { modelConfig } : {}),
    };
  });
  // Agent-driven work panel preview (D100): open a workspace HTML file in
  // the embedded browser; live reload keeps it current through later edits.
  s.setLocalTool("BrowserPreview", async ({ args, sessionId }) => {
    const raw = String((args as { path?: unknown })?.path ?? "").trim();
    if (!raw) {
      return {
        ok: false,
        isError: true,
        content: "BrowserPreview: `path` is required.",
      };
    }
    let root: string | null = null;
    try {
      const res = (await host?.call("session.get", { id: sessionId })) as
        | { session: { projectPath?: string } | null }
        | undefined;
      root = res?.session?.projectPath?.trim() || null;
    } catch {
      root = null;
    }
    if (!root) {
      return {
        ok: false,
        isError: true,
        content: "BrowserPreview: no workspace is open.",
      };
    }
    if (!resolveLocalFile(raw, root)) {
      return {
        ok: false,
        isError: true,
        content: `BrowserPreview: "${raw}" does not resolve to an existing file inside the workspace.`,
      };
    }
    const preview = await browserHost.previewWorkspaceFile(sessionId, raw, root);
    if (!preview.ok) {
      return {
        ok: false,
        isError: true,
        content: preview.content,
      };
    }
    sendToRenderer(IPC.event.browserPreview, {
      sessionId,
      path: raw,
    });
    return {
      ok: true,
      content: `Previewing ${raw} in the work-panel Browser plugin. Live reload is active — subsequent edits to the file or sibling assets re-render automatically.`,
    };
  });
  // Plugin skills (D174): the model loads a declared skill document by id.
  // Served in main because the plugin runtime — and the plugin directories —
  // live here, not in host-core.
  s.setLocalTool("Skill", async ({ args, sessionId }) => {
    const id = String((args as { id?: unknown })?.id ?? "").trim();
    if (!id) {
      return {
        ok: false,
        isError: true,
        content: "Skill: `id` is required. Use an id from the Skills section.",
      };
    }
    const projectPath = sessionProjects.get(sessionId) ?? null;
    try {
      // Bundled skills answer first; they are not owned by any plugin. A user
      // skill is looked up next, and only then a plugin's — the ids cannot
      // collide, since a plugin skill id always carries a `<pluginId>/` prefix.
      const skill =
        loadBuiltinSkillBody(id) ??
        (await loadUserSkillBody(id, projectPath)) ??
        plugins.loadSkillBody(id);
      return {
        ok: true,
        content: `# Skill: ${skill.name} (${skill.id})\n\n${skill.body}`,
      };
    } catch (error) {
      const userIds = (await activeUserSkills(projectPath ?? undefined)).map(
        (skill) => skill.id,
      );
      const pluginIds = plugins
        .getSkills()
        .filter((skill) => pluginActiveInProject(skill.pluginId, projectPath))
        .map((skill) => skill.id);
      const available = [...userIds, ...pluginIds].join(", ");
      return {
        ok: false,
        isError: true,
        content: `Skill: ${error instanceof Error ? error.message : String(error)}.${
          available ? ` Available skills: ${available}.` : ""
        }`,
      };
    }
  });
  // Plugin authoring (D171): scaffold, validate and package a plugin without
  // leaving the session. Paths stay inside the open workspace.
  registerPluginDevTools(s, {
    resolveWorkspace: async (sessionId) => {
      try {
        const res = (await host?.call("session.get", { id: sessionId })) as
          | { session: { projectPath?: string } | null }
          | undefined;
        return res?.session?.projectPath?.trim() || null;
      } catch {
        return null;
      }
    },
    registerDevPlugin: async (path) => {
      if (!host) throw new Error("host unavailable");
      const loaded = await host.call<{ plugin?: { permissions?: string[] } }>(
        "plugins.loadDev",
        { path },
      );
      return loaded.plugin?.permissions ?? [];
    },
    loadPlugin: async (path, permissions) => {
      const manifest = await plugins.loadFromPath(path, permissions ?? [], {
        development: true,
      });
      plugins.watchDevPlugin(manifest.id);
      for (const toast of plugins.drainToasts()) {
        sendToRenderer(IPC.event.toast, { message: toast });
      }
      sendToRenderer(IPC.event.pluginChanged,{ reason: "scaffold" });
    },
  });
  sidecar = s;
  if (host) s.setHost(host);
  await s.call("sidecar.configure", {
    hostBinary: host?.binaryPath,
    dataDir,
    networkProxy: currentNetworkProxy(),
  });
  logger.app("runtime", "info", "agent sidecar configured");
}

/// Close the open turn + scheduled run (if any) for a session. Both host
/// updates are idempotent (guarded on status='running').
function finishTurn(
  sessionId: string,
  status: "completed" | "aborted" | "error",
  errorCode?: string,
  options: { createNotification?: boolean; recoverInflight?: boolean } = {},
): Promise<void> {
  const existing = turnFinalizations.get(sessionId);
  if (existing) return existing;

  const finalization = (async () => {
    const turnId = activeTurns.get(sessionId);
    const turnKey = turnId
      ? planSubmissionTurnKey(sessionId, turnId)
      : undefined;
    const wasPlanSubmission = turnKey
      ? planSubmissionTurnIds.has(turnKey)
      : false;

    try {
      if (host && turnId) {
        const createNotification =
          options.createNotification ??
          (!wasPlanSubmission && shouldCreateTaskNotification(sessionId));
        const turnUsage = activeTurnUsages.get(sessionId);
        activeTurnUsages.delete(sessionId);
        try {
          const result = await host.call<{
            ok: boolean;
            notification?: AppNotification;
            recovered?: UiMessage;
          }>("session.endTurn", {
            turnId,
            status,
            errorCode,
            createNotification,
            ...(turnUsage ? { usage: turnUsage } : {}),
            // The reply can no longer finish on its own: promote its last
            // checkpoint instead of waiting for a final row that never comes.
            ...(options.recoverInflight ? { recoverInflight: true } : {}),
          });
          if (result.notification) {
            sendToRenderer(IPC.event.notificationChanged, {
              notification: result.notification,
            });
          }
          if (result.recovered) {
            // Settle the renderer's streaming row the same way a final
            // message_end would have, so it does not stay "streaming" forever.
            emitAgentEvent({
              sessionId,
              turnId,
              ts: Date.now(),
              event: { type: "message_end", message: result.recovered },
            } satisfies AgentEventEnvelope);
          }
        } catch (e) {
          logger.app("persistence", "warn", "endTurn failed", {
            sessionId,
            data: String(e),
          });
        }
      }

      const runId = scheduledRunsBySession.get(sessionId);
      if (runId) {
        scheduledRunsBySession.delete(sessionId);
        if (host) {
          await host
            .call("scheduled.finishRun", { runId, status, errorCode })
            .catch((e) =>
              logger.app("persistence", "warn", "finishRun failed", {
                sessionId,
                data: String(e),
              }),
            );
        }
      }
    } finally {
      // Do not release local ownership or wake a queued approved execution
      // until the durable endTurn request has settled above.
      if (turnId && activeTurns.get(sessionId) === turnId) {
        activeTurns.delete(sessionId);
      }
      if (turnKey) {
        planSubmissionTurnIds.delete(turnKey);
        const waiters = turnSettlements.get(turnKey);
        if (waiters) {
          turnSettlements.delete(turnKey);
          for (const resolve of waiters) resolve();
        }
      }
    }

    if (turnId) {
      const toolPrefix = `${sessionId}:`;
      // A host tool can finish shortly after the turn is aborted. Keep metadata
      // long enough for a late tool_end to persist a readable historical row,
      // but never clear a newer turn's long-running tools (TaskWait may span
      // this window).
      setTimeout(() => {
        for (const [key, call] of activeToolCalls) {
          if (key.startsWith(toolPrefix) && call.turnId === turnId) {
            activeToolCalls.delete(key);
          }
        }
      }, 5 * 60 * 1000).unref();
    }
  })();

  turnFinalizations.set(sessionId, finalization);
  const releaseFinalization = () => {
    if (turnFinalizations.get(sessionId) === finalization) {
      turnFinalizations.delete(sessionId);
      // The terminal event reaches Agent Host while activeTurns still owns
      // this session. Retry its deferred queue drain once settlement releases
      // both busy guards, unless the application is shutting down.
      if (!quitting) agentHostBridge?.agentHost.kick(sessionId);
    }
  };
  void finalization.then(releaseFinalization, releaseFinalization);
  return finalization;
}

async function finishApprovedExecution(
  executionId: string,
  status: PlanExecutionFinishStatus,
  errorCode?: string,
): Promise<void> {
  if (finishedApprovedExecutions.has(executionId)) return;
  if (inFlightExecutionFinishes.has(executionId)) return;
  if (!pendingExecutionFinishes.has(executionId)) {
    pendingExecutionFinishes.set(executionId, { status, errorCode });
  }
  inFlightExecutionFinishes.add(executionId);
  if (!host) {
    inFlightExecutionFinishes.delete(executionId);
    return;
  }
  try {
    const pending = pendingExecutionFinishes.get(executionId) ?? {
      status,
      errorCode,
    };
    await host.call("plans.finishExecution", {
      executionId,
      status: pending.status,
      ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
    });
    finishedApprovedExecutions.add(executionId);
    startedApprovedExecutions.delete(executionId);
    pendingExecutionFinishes.delete(executionId);
    const turn = approvedExecutionTurns.get(executionId);
    const sessionId = turn?.sessionId ?? claimedExecutionSessions.get(executionId);
    if (sessionId && approvedExecutionIdsBySession.get(sessionId) === executionId) {
      approvedExecutionIdsBySession.delete(sessionId);
    }
    approvedExecutionTurns.delete(executionId);
    claimedExecutionSessions.delete(executionId);
  } catch (error) {
    logger.app("runtime", "warn", "approved plan execution finalization failed", {
      data: { executionId, error: String(error) },
    });
  } finally {
    inFlightExecutionFinishes.delete(executionId);
  }
}

async function dispatchApprovedPlan(rawExecution: unknown): Promise<void> {
  const initial = planExecutionFromUnknown(rawExecution);
  if (!initial) {
    logger.app("runtime", "warn", "approved plan execution descriptor was invalid");
    return;
  }
  const releaseSessionOperation = await acquireSessionOperation(initial.sessionId);
  try {
  if (
    initial.state === "running" ||
    initial.state === "interrupted" ||
    initial.state === "completed" ||
    startedApprovedExecutions.has(initial.id) ||
    finishedApprovedExecutions.has(initial.id) ||
    dispatchingApprovedExecutions.has(initial.id)
  ) {
    return;
  }
  if (!host || !sidecar) return;
  dispatchingApprovedExecutions.add(initial.id);
  let claimed = false;
  let turnId: string | undefined;
  try {
    const activeTurnId = activeTurns.get(initial.sessionId);
    if (
      activeTurnId &&
      planSubmissionTurnIds.has(
        planSubmissionTurnKey(initial.sessionId, activeTurnId),
      )
    ) {
      await waitForTurnSettlement(initial.sessionId, activeTurnId);
    }
    if (activeTurns.has(initial.sessionId)) {
      const retry = setTimeout(() => {
        void dispatchApprovedPlan(initial);
      }, 250);
      retry.unref();
      return;
    }
    const claimResponse = await host.call("plans.claimExecution", {
      executionId: initial.id,
    });
    const claimedExecution = executionFromResponse(claimResponse);
    if (
      claimedExecution?.state === "interrupted" ||
      claimedExecution?.state === "completed" ||
      claimedExecution?.state === "running"
    ) {
      // A running descriptor is the host's durable ownership signal. It may
      // belong to a previous process and must never be replayed here.
      if (claimedExecution.state !== "running") return;
    }
    const execution: PlanExecution = {
      ...(claimedExecution ?? initial),
      state: "running",
    };
    claimed = true;
    claimedExecutionSessions.set(execution.id, execution.sessionId);

    const [settings, sessionResult] = await Promise.all([
      host.call("settings.get"),
      host.call<{ session?: any }>("session.get", { id: execution.sessionId }),
    ]);
    if (!sessionResult.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const launch = await resolveAgentRuntimeLaunch(
      execution.sessionId,
      sessionResult.session,
      settings,
      { mode: "agent" },
    );
    const turn = await host.call<{ turnId: string }>("session.beginTurn", {
      sessionId: execution.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    turnId = String(turn.turnId || "").trim();
    if (!turnId) throw new Error("execution turn was not created");
    activeTurns.set(execution.sessionId, turnId);
    activeTurnUsages.delete(execution.sessionId);
    approvedExecutionIdsBySession.set(execution.sessionId, execution.id);
    approvedExecutionTurns.set(execution.id, {
      sessionId: execution.sessionId,
      turnId,
    });
    startedApprovedExecutions.add(execution.id);
    const accepted = await sidecar.call<{ accepted: boolean }>(
      "agent.executeApprovedPlan",
      {
        ...launch.sidecarParams,
        mode: "agent",
        turnId,
        execution,
      },
    );
    if (accepted?.accepted !== true) {
      throw new Error("approved plan execution was not accepted");
    }
    logger.app("runtime", "info", "approved plan execution started", {
      sessionId: execution.sessionId,
      data: { executionId: execution.id, turnId },
    });
  } catch (error: any) {
    const errorCode =
      error?.data?.errorCode || error?.errorCode || ErrorCodes.PLAN_EXECUTION_INTERRUPTED;
    if (turnId && activeTurns.get(initial.sessionId) === turnId) {
      await finishTurn(initial.sessionId, "error", errorCode);
    }
    if (claimed) {
      await finishApprovedExecution(initial.id, "interrupted", errorCode);
    }
    logger.app("runtime", "warn", "approved plan execution failed to start", {
      sessionId: initial.sessionId,
      data: { executionId: initial.id, error: String(error) },
    });
  } finally {
      dispatchingApprovedExecutions.delete(initial.id);
    }  } finally {
    releaseSessionOperation();
  }

}

async function drainApprovedPlanExecutions(): Promise<void> {
  if (approvedExecutionDrain) return approvedExecutionDrain;
  approvedExecutionDrain = (async () => {
    if (!host || !sidecar) return;
    for (const [executionId, finish] of pendingExecutionFinishes) {
      await finishApprovedExecution(executionId, finish.status, finish.errorCode);
    }
    const response = await host.call("plans.queuedExecutions");
    for (const execution of executionListFromResponse(response)) {
      // Only queued rows are dispatchable. Running/interrupted rows are durable
      // recovery outcomes and must remain untouched on startup.
      if (execution.state !== "queued") continue;
      await dispatchApprovedPlan(execution);
    }
  })();
  try {
    await approvedExecutionDrain;
  } finally {
    approvedExecutionDrain = null;
  }
}

async function dispatchExecutionForProposal(proposalId: string): Promise<void> {
  if (!host) return;
  try {
    const response = await host.call("plans.queuedExecutions");
    const execution = executionListFromResponse(response).find(
      (candidate) => candidate.proposalId === proposalId,
    );
    if (execution?.state === "queued") {
      await dispatchApprovedPlan(execution);
    }
  } catch (error) {
    logger.app("runtime", "warn", "approved plan lookup after resolution failed", {
      data: String(error),
    });
  }
}

/**
 * Carry subagent attribution from the event envelope onto the persisted row, so
 * a reloaded session still nests the row under its `Task` call and still keeps
 * it out of the parent's model context (ADR 0062).
 */
function subagentTagged(message: UiMessage, envelope: AgentEventEnvelope): UiMessage {
  if (!envelope.parentToolCallId) return message;
  return {
    ...message,
    parentToolCallId: envelope.parentToolCallId,
    ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
  };
}

function persistAgentEvent(envelope: AgentEventEnvelope): UiMessage | undefined {
  const event = envelope.event;
  const turnId = activeTurns.get(envelope.sessionId);
  const executionId = (() => {
    const candidate = approvedExecutionIdsBySession.get(envelope.sessionId);
    if (!candidate) return undefined;
    if (pendingExecutionFinishes.get(candidate)?.status === "interrupted") {
      return undefined;
    }
    const executionTurn = approvedExecutionTurns.get(candidate);
    return executionTurn?.turnId === (envelope.turnId || turnId)
      ? candidate
      : undefined;
  })();
  if (
    event.type === "planning_state" &&
    event.state === "awaiting_approval" &&
    (envelope.turnId || turnId)
  ) {
    planSubmissionTurnIds.add(
      planSubmissionTurnKey(envelope.sessionId, envelope.turnId || turnId!),
    );
  }
  if (event.type === "message_update" && event.message.role === "assistant") {
    // Checkpoint only the session's own reply (D299). Delegate rows stream in
    // parallel with the parent's and would thrash a per-session checkpoint;
    // their loss on a crash is bounded to the Task call's activity.
    if (!envelope.parentToolCallId) {
      inflightCheckpointer.observe({
        sessionId: envelope.sessionId,
        turnId: envelope.turnId ?? turnId,
        message: event.message,
      });
    }
    return;
  }
  if (event.type === "tool_start") {
    activeToolCalls.set(activeToolCallKey(envelope.sessionId, event.toolCallId), {
      toolName: event.toolName,
      args: event.args,
      createdAt: new Date(envelope.ts).toISOString(),
      turnId: envelope.turnId ?? turnId,
      ...(envelope.parentToolCallId
        ? { parentToolCallId: envelope.parentToolCallId }
        : {}),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
    });
    if (
      (event.toolName === "SubmitPlan" || event.toolName === "SubmitGoal") &&
      (envelope.turnId || turnId)
    ) {
      planSubmissionTurnIds.add(
        planSubmissionTurnKey(envelope.sessionId, envelope.turnId || turnId!),
      );
    }
  }
  if (event.type === "error") {
    // Async provider failures must close the durable turn / scheduled run the
    // same way agent_end does; otherwise they stay 'running' in the DB.
    logger.app("session", "error", "agent turn failed", {
      sessionId: envelope.sessionId,
      code: event.error.code,
      data: {
        message: event.error.message,
        retriable: event.error.retriable,
        details: event.error.details,
      },
    });
    const turnFinalization = finishTurn(
      envelope.sessionId,
      event.error.code === "TURN_ABORTED" ? "aborted" : "error",
      event.error.code,
    );
    if (executionId) {
      void turnFinalization.then(() =>
        finishApprovedExecution(
          executionId,
          "interrupted",
          event.error.code,
        ),
      );
    }
    return;
  }
  if (event.type === "agent_end") {
    const turnFinalization = finishTurn(envelope.sessionId, "completed");
    if (executionId) {
      void turnFinalization.then(() =>
        finishApprovedExecution(executionId, "completed"),
      );
    }
    // Persist the completed branch as the active regenerate revision when the
    // latest user turn carries revision metadata (ChatGPT-style history).
    void (async () => {
      try {
        if (!host) return;
        // The turn's final assistant message may still be in the outbox. Archive
        // a branch that is missing it and the answer is missing from the restored
        // branch forever, so drain first and skip the archive if the host cannot
        // take the writes right now. The yield lets a message_end enqueued in
        // this same event-loop turn reach the queue before it is measured.
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (let attempt = 0; attempt < 3 && persistenceOutbox.size() > 0; attempt += 1) {
          await persistenceOutbox.flush(() => host);
        }
        if (persistenceOutbox.size() > 0) {
          logger.app("persistence", "warn", "skipped regenerate branch archive", {
            sessionId: envelope.sessionId,
            data: { pending: persistenceOutbox.size() },
          });
          return;
        }
        // One host call does the read, the archive and the pager stamp under the
        // RPC lock. The read-modify-write this replaced raced the append above
        // and wrote a stale transcript back over the final message.
        const saved = await host.call<{
          saved?: { root?: any } | null
        }>("session.saveActiveRevision", { sessionId: envelope.sessionId });
        const root = saved.saved?.root;
        if (!root) return;
        emitAgentEvent({
          sessionId: envelope.sessionId,
          ts: Date.now(),
          event: { type: "message_end", message: root },
        } satisfies AgentEventEnvelope);
      } catch (error) {
        logger.app("persistence", "warn", "save active regenerate branch failed", {
          sessionId: envelope.sessionId,
          data: String(error),
        });
      }
    })();
    return;
  }
  if (event.type === "turn_end" && !envelope.parentToolCallId) {
    addActiveTurnUsage(envelope.sessionId, event.subagentUsage);
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (!envelope.parentToolCallId && event.message.usage) {
      addActiveTurnUsage(envelope.sessionId, event.message.usage);
    }
    // Checkpoint the finished snapshot before the outbox append (D327).
    // Settling first dropped the last interval of text, and endTurn used to
    // delete the host file while the final row was still queued.
    if (!envelope.parentToolCallId) {
      const sessionId = envelope.sessionId;
      const finalId = event.message.id;
      inflightCheckpointer.observe({
        sessionId,
        turnId: envelope.turnId ?? turnId,
        message: event.message,
      });
      void inflightCheckpointer.flush(sessionId).finally(() => {
        inflightCheckpointer.settleIf(sessionId, finalId);
      });
    }
    // Empty aborted bubbles are not useful transcript rows. Structured
    // provider failures remain durable assistant messages so their details
    // stay attached to the failed turn after reload.
    const failed =
      event.message.status === "error" || event.message.status === "aborted";
    const empty =
      !(event.message.content || "").trim() &&
      !(event.message.thinking || "").trim();
    if (failed && empty && !event.message.error) return;
    void persistenceOutbox
      .enqueue(
        {
          key: `message:${envelope.sessionId}:${event.message.id}`,
          sessionId: envelope.sessionId,
          message: subagentTagged(event.message, envelope),
          turnId,
        },
        () => host,
      )
      .catch((e) =>
        logger.app("persistence", "warn", "assistant message persistence enqueue failed", {
          sessionId: envelope.sessionId,
          data: String(e),
        }),
      );
  }
  if (event.type === "tool_end") {
    const key = activeToolCallKey(envelope.sessionId, event.toolCallId);
    const started = activeToolCalls.get(key);
    activeToolCalls.delete(key);
    const message: UiMessage = {
      id: event.toolCallId,
      role: "tool",
      content:
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result),
      createdAt: started?.createdAt ?? new Date(envelope.ts).toISOString(),
      toolCallId: event.toolCallId,
      toolName: started?.toolName,
      toolArgs: started?.args,
      toolStatus: event.isError ? "error" : "success",
      toolResult: event.result,
      ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
      toolCompletedAt: new Date(envelope.ts).toISOString(),
      toolDurationMs: started
        ? Math.max(0, envelope.ts - Date.parse(started.createdAt))
        : undefined,
      isError: event.isError,
      status: "complete",
      ...(started?.parentToolCallId
        ? { parentToolCallId: started.parentToolCallId }
        : {}),
      ...(started?.agentName ? { agentName: started.agentName } : {}),
    };
    void persistenceOutbox
      .enqueue(
        {
          key: `message:${envelope.sessionId}:${event.toolCallId}`,
          sessionId: envelope.sessionId,
          message,
          // A late tool_end belongs to the turn that started the tool, even if
          // another prompt has already opened a newer turn for this session.
          turnId: started?.turnId ?? envelope.turnId ?? turnId,
        },
        () => host,
      )
      .catch((e) =>
        logger.app("persistence", "warn", "tool message persistence enqueue failed", {
          sessionId: envelope.sessionId,
          toolCallId: (event as any).toolCallId,
          data: String(e),
        }),
      );
    return message;
  }
}

function superviseRestart(kind: RestartKind): Promise<void> {
  const existing = restartInFlight[kind];
  if (existing) return existing;
  const run = superviseRestartLoop(kind).finally(() => {
    if (restartInFlight[kind] === run) restartInFlight[kind] = null;
  });
  restartInFlight[kind] = run;
  return run;
}

async function superviseRestartLoop(kind: RestartKind): Promise<void> {
  const st = restartState[kind];
  while (!quitting) {
    const now = Date.now();
    if (now - st.windowStart > RESTART_WINDOW_MS) {
      st.windowStart = now;
      st.count = 0;
    }
    st.count += 1;
    if (st.count > MAX_RESTARTS_PER_WINDOW) {
      logger.app("runtime", "error", `${kind} restart limit reached; giving up`, {
        code: ErrorCodes.HOST_UNAVAILABLE,
      });
      sendToRenderer(IPC.event.hostStatus, {
        ok: false,
        component: kind,
        fatal: true,
      });
      return;
    }
    const delay = Math.min(500 * 2 ** (st.count - 1), 4000);
    await new Promise((r) => setTimeout(r, delay));
    if (quitting) return;
    try {
      if (kind === "host") {
        await startHost();
        if (sidecar && host) sidecar.setHost(host);
      } else {
        await startSidecar();
      }
      await drainApprovedPlanExecutions();
      logger.app("runtime", "warn", `${kind} restarted after crash`);
      sendToRenderer(IPC.event.hostStatus, {
        ok: true,
        component: kind,
        restarted: true,
      });
      return;
    } catch (e) {
      const schema = schemaTooNewOf(e);
      if (schema) {
        logger.app("runtime", "error", "local data schema is newer than this build", {
          code: ErrorCodes.HOST_UNAVAILABLE,
          data: schema,
        });
        sendToRenderer(IPC.event.hostStatus, {
          ok: false,
          component: kind,
          fatal: true,
          message: DB_SCHEMA_TOO_NEW_STATUS,
          schema,
        });
        return;
      }
      if (isGlibcUnsupportedError(e)) {
        logger.app("runtime", "error", "linux glibc is below the packaged host floor", {
          code: ErrorCodes.HOST_UNAVAILABLE,
          data: String(e),
        });
        sendToRenderer(IPC.event.hostStatus, {
          ok: false,
          component: kind,
          fatal: true,
          message: GLIBC_UNSUPPORTED_STATUS,
        });
        return;
      }
      logger.app("runtime", "error", `${kind} restart failed`, { data: String(e) });
    }
  }
}

/**
 * Boot outcome pushed once the renderer has mounted. Known unrecoverable
 * failures travel as status tokens the UI can phrase; anything else is the
 * raw error. The architecture check rides along even on success so an Intel
 * build under Rosetta gets a hint instead of silently running slower.
 */
function bootHostStatus(bootError: unknown): HostStatusEvent {
  const status: HostStatusEvent = { ok: !bootError };
  if (bootError) {
    status.component = "host";
    status.fatal = true;
    const schema = schemaTooNewOf(bootError);
    if (schema) {
      status.message = DB_SCHEMA_TOO_NEW_STATUS;
      status.schema = schema;
    } else if (isGlibcUnsupportedError(bootError)) {
      status.message = GLIBC_UNSUPPORTED_STATUS;
    } else {
      status.message = String(bootError);
    }
  }
  const arch = runtimeArch();
  if (arch.mismatch) {
    status.archMismatch = {
      platform: arch.platform,
      processArch: arch.processArch,
      machineArch: arch.machineArch,
    };
  }
  return status;
}

let runtimeArchCache: ReturnType<typeof detectRuntimeArch> | null = null;
function runtimeArch() {
  if (!runtimeArchCache) {
    runtimeArchCache = detectRuntimeArch();
    if (runtimeArchCache.mismatch) {
      logger.app("lifecycle", "warn", "build is not native to this cpu", {
        data: runtimeArchCache,
      });
    }
  }
  return runtimeArchCache;
}

async function bootBackends() {
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  logger.app("lifecycle", "info", `app boot ${APP_NAME} ${APP_VERSION}`, {
    data: { protocolVersion: PROTOCOL_VERSION },
  });
  await startHost();
  try {
    const stored = await host!.call("settings.get");
    await applyNetworkProxyFromAppSettings(stored);
  } catch {
    await applyNetworkProxyFromAppSettings({ mode: "system" });
  }
  await startSidecar();

  // Keep plugin host services wired to live workspace / app metadata.
  plugins.setServices({
    getWorkspacePath: () => {
      try {
        // Best-effort sync cache; refreshed on demand by callers that await host.
        return (globalThis as any).__piWorkspacePath ?? null;
      } catch {
        return null;
      }
    },
    getAppVersion: () => APP_VERSION,
  });
  try {
    const ws = await host!.call<{ workspace: { path?: string } | null }>("workspace.get");
    setCurrentWorkspacePath(ws.workspace?.path ?? null);
  } catch {
    setCurrentWorkspacePath(null);
  }

  // Restore enabled plugins
  try {
    const listed = await host!.call<{ plugins: any[] }>("plugins.list");
    rememberPluginScopes(listed.plugins ?? []);
    for (const p of listed.plugins ?? []) {
      if (p.enabled && p.path) {
        try {
          await plugins.loadFromPath(p.path, p.permissions ?? [], {
            development: p.source === "dev",
          });
          // Dev plugins keep hot reload across restarts: the folder was picked
          // once, and the edit loop should not have to pick it again.
          if (p.source === "dev") plugins.watchDevPlugin(p.id);
          logger.app("plugin", "info", "plugin restored", { pluginId: p.id });
        } catch (e) {
          logger.app("plugin", "error", "plugin restore failed", {
            pluginId: p.id,
            data: String(e),
          });
        }
      }
    }
  } catch (e) {
    logger.app("plugin", "error", "plugin list failed", { data: String(e) });
  }

  // The user's MCP servers are only *registered* here; each one connects the
  // first time a session that can see it is assembled, so a project-scoped
  // server costs nothing until that project is open.
  await refreshUserMcp();
  await drainApprovedPlanExecutions().catch((error) =>
    logger.app("runtime", "warn", "queued approved plan drain failed", {
      data: String(error),
    }),
  );
}

function registerIpc() {
  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    ipcHandlers.set(channel, fn);
    ipcMain.handle(channel, async (_event, ...args) => wrap(() => fn(...args)));
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: { sender: { id: number } }, ...args: any[]) => Promise<any>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) =>
      wrap(() => fn(event, ...args)),
    );
  };
  const assertMainWindowSender = (event: { sender: { id: number } }): void => {
    if (event.sender.id !== mainWindow?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  handle(IPC.invoke.pluginLauncherToggle, async () => {
    await togglePluginLauncher();
    return { visible: pluginLauncherWindow?.isVisible() ?? false };
  });
  ipcMain.handle(IPC.invoke.pluginLauncherDismiss, async (event) =>
    wrap(async () => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && window === pluginLauncherWindow && !window.isDestroyed()) {
        window.hide();
      }
      return { visible: false };
    }),
  );

  handle(IPC.invoke.appOpenFeedback, async () => {
    const hostVersion = host
      ? await host
          .call<{ version: string }>("app.getVersion")
          .then((info) => info.version)
          .catch(() => undefined)
      : undefined;
    const url = buildBugReportUrl({
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: PROTOCOL_VERSION,
      hostVersion,
    });
    assertFeedbackIssueUrl(url);
    await safeOpenExternal(url);
    return { ok: true };
  });

  handle(IPC.invoke.appGetVersion, async () => {
    const hostVersion = host
      ? await host.call<{ version: string; protocolVersion: number }>(
          "app.getVersion",
        )
      : undefined;
    return {
      name: APP_NAME,
      version: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      hostProtocolVersion: hostVersion?.protocolVersion,
      hostVersion: hostVersion?.version,
      platform: process.platform,
      arch: process.arch,
    };
  });

  handle(IPC.invoke.appHealth, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("app.health");
  });

  handle(IPC.invoke.appGetOnboarding, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("app.getOnboarding");
  });

  handle(IPC.invoke.appDismissOnboarding, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call<any>("settings.get");
    await host.call("settings.set", { ...settings, onboardingDismissed: true });
    return { ok: true };
  });

  // Installed system font families for the Settings font picker. Enumerating
  // the OS font catalog is comparatively slow (a few hundred ms to seconds),
  // so the result is cached briefly per process.
  let systemFontsCache: { at: number; fonts: string[] } | null = null;
  handle(IPC.invoke.systemFontsList, async () => {
    const now = Date.now();
    if (systemFontsCache && now - systemFontsCache.at < 60_000) {
      return systemFontsCache.fonts;
    }
    const families = await listInstalledFonts().catch(() => []);
    systemFontsCache = { at: now, fonts: families };
    return families;
  });

  const instructionFile = async (
    scope: "global" | "project",
    projectPath?: string | null,
  ) => {
    const path =
      scope === "global"
        ? globalInstructionPath()
        : projectPath
          ? join(projectPath, "AGENTS.md")
          : null;
    if (!path) {
      throw Object.assign(new Error("workspace required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const { readFile } = await import("node:fs/promises");
    try {
      return { scope, path, content: await readFile(path, "utf8"), exists: true };
    } catch {
      return { scope, path, content: "", exists: false };
    }
  };

  const managedProjectPath = async (input: unknown): Promise<string> => {
    if (!host) throw new Error("host unavailable");
    const requestedPath = typeof input === "string" ? input.trim() : "";
    if (!requestedPath) {
      throw Object.assign(new Error("project path required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const projectPath = resolve(requestedPath);
    const listed = (await host.call("projects.list")) as {
      projects?: Array<{ path?: string }>;
    };
    const known = (listed.projects ?? []).some((project) => {
      const candidate = String(project?.path ?? "").trim();
      return candidate && resolve(candidate) === projectPath;
    });
    if (!known) {
      throw Object.assign(new Error("project not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw Object.assign(new Error("project folder not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return projectPath;
  };

  handle(
    IPC.invoke.agentInstructionsGet,
    async (input: { projectPath?: unknown } = {}) => {
      const projectPath = input.projectPath === undefined
        ? null
        : await managedProjectPath(input.projectPath);
    return {
      global: await instructionFile("global"),
      ...(projectPath
        ? { project: await instructionFile("project", projectPath) }
        : {}),
    };
  });

  handle(
    IPC.invoke.agentInstructionsSave,
    async (input: {
      scope?: "global" | "project";
      content?: unknown;
      projectPath?: unknown;
    } = {}) => {
      if (input.scope !== "global" && input.scope !== "project") {
        throw Object.assign(new Error("instruction scope required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const scope = input.scope;
      const projectPath = scope === "project"
        ? await managedProjectPath(input.projectPath)
        : null;
      const file = await instructionFile(scope, projectPath);
      const content = typeof input.content === "string" ? input.content : "";
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, content, "utf8");
      return { file: { ...file, content, exists: true } };
    },
  );

  handle(
    IPC.invoke.projectMemoryGet,
    async (input: { projectPath?: unknown } = {}) => {
      const projectPath = await managedProjectPath(input.projectPath);
      if (!host) throw new Error("host unavailable");
      return host.call("project.memory.get", { path: projectPath });
    },
  );

  handle(
    IPC.invoke.projectMemorySave,
    async (input: { projectPath?: unknown; content?: unknown } = {}) => {
      const projectPath = await managedProjectPath(input.projectPath);
      if (!host) throw new Error("host unavailable");
      const content = typeof input.content === "string" ? input.content : "";
      return host.call("project.memory.set", { path: projectPath, content });
    },
  );

  handle(IPC.invoke.updatesGetState, async () => updater.getState());

  handle(IPC.invoke.updatesCheck, async () => updater.check({ manual: true }));

  handle(IPC.invoke.updatesDownload, async () => updater.download());

  handle(IPC.invoke.updatesInstall, async () => {
    updater.install();
    return { ok: true };
  });

  handle(IPC.invoke.updatesOpenReleases, async () => {
    await updater.openReleases();
    return { ok: true };
  });

  handle(IPC.invoke.notificationList, async (input: {
    unreadOnly?: boolean;
    limit?: number;
  } = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("notification.list", input);
  });

  handle(IPC.invoke.notificationMarkRead, async (input: { id?: string } = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("notification.markRead", input);
  });

  handle(IPC.invoke.notificationMarkAllRead, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("notification.markAllRead");
  });

  handle(IPC.invoke.notificationClear, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("notification.clear");
  });

  handle(
    IPC.invoke.notificationSetViewingSession,
    async (input: { sessionId?: unknown } = {}) => {
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : "";
      notificationViewingSessionId = sessionId || null;
      return { ok: true };
    },
  );

  handle(IPC.invoke.notificationShowNative, async (input: {
    id?: string;
    sessionId?: string;
    kind?: "task" | "interactive";
    title?: string;
    body?: string;
  } = {}) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !SystemNotification.isSupported()
    ) {
      return { shown: false };
    }
    const id = String(input.id ?? "");
    const sessionId = String(input.sessionId ?? "");
    const kind = input.kind === "interactive" ? "interactive" : "task";
    const title = String(input.title ?? "").trim().slice(0, 100);
    const body = String(input.body ?? "").trim().slice(0, 240);
    if (!id || !sessionId || !title) return { shown: false };

    const liveWindow = mainWindow !== null && !mainWindow.isDestroyed();
    const windowVisible = liveWindow && mainWindow.isVisible() === true;
    const windowFocused = liveWindow && mainWindow.isFocused() === true;
    if (
      !shouldShowNativeNotification({
        kind,
        sessionId,
        viewingSessionId: notificationViewingSessionId,
        windowVisible,
        windowFocused,
      })
    ) {
      return { shown: false };
    }

    const notification = new SystemNotification({ title, body });
    notification.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      sendToRenderer(IPC.event.notificationActivated, { id, sessionId });
    });
    notification.show();
    return { shown: true };
  });

  handle(IPC.invoke.sessionList, async () => {
    if (!host) throw new Error("host unavailable");
    const [result, { providers, defaults }] = await Promise.all([
      host.call<{ sessions: RuntimeSession[] }>("session.list"),
      sessionCapabilityContext(),
    ]);
    return {
      ...result,
      sessions: result.sessions.map((session) =>
        enrichSession(session, providers, defaults),
      ),
    };
  });
  handle(IPC.invoke.sessionCreate, async (input = {}) => {
    if (!host) throw new Error("host unavailable");
    const capabilityPromise = sessionCapabilityContext();
    const res = await host.call<{ session?: (RuntimeSession & { id?: string }) | null }>(
      "session.create",
      input,
    );
    logger.app("session", "info", "session created", { sessionId: res.session?.id });
    if (!res.session) return res;
    const { providers, defaults } = await capabilityPromise;
    return { ...res, session: enrichSession(res.session, providers, defaults) };
  });
  handle(
    IPC.invoke.sessionFork,
    async (
      input: { sessionId?: string; title?: string; throughMessageId?: string } = {},
    ) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot fork a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      // Resolve enrichment before the mutation so a provider-list failure
      // cannot report a failed IPC after the child has already been committed.
      const { providers, defaults } = await sessionCapabilityContext();
      let result: { session?: RuntimeSession | null };
      try {
        result = await host.call("session.fork", {
          sessionId,
          title: String(input.title ?? "").trim() || undefined,
          throughMessageId:
            String(input.throughMessageId ?? "").trim() || undefined,
        });
      } catch (error: any) {
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot fork a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      logger.app("session", "info", "session forked", {
        sessionId: (result.session as { id?: string }).id,
        data: { sourceSessionId: sessionId },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
    },
  );
  handle(
    IPC.invoke.sessionGet,
    async (
      input:
        | string
        | {
            id?: string;
            messageBefore?: number;
            messageLimit?: number;
            contentLimit?: number;
          },
    ) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof input === "string" ? { id: input } : input ?? {};
      const id = String(request.id ?? "").trim();
      if (!id) throw new Error("session id required");
      const [result, { providers, defaults }] = await Promise.all([
        host.call<{ session?: RuntimeSession | null }>("session.get", {
          id,
          ...(Number.isInteger(request.messageBefore) && request.messageBefore! >= 0
            ? { messageBefore: request.messageBefore }
            : {}),
          ...(Number.isInteger(request.messageLimit) && request.messageLimit! > 0
            ? { messageLimit: request.messageLimit }
            : {}),
          ...(Number.isInteger(request.contentLimit) && request.contentLimit! > 0
            ? { contentLimit: request.contentLimit }
            : {}),
        }),
        sessionCapabilityContext(),
      ]);
      return result.session
        ? { ...result, session: enrichSession(result.session, providers, defaults) }
        : result;
    },
  );
  handle(IPC.invoke.sessionDelete, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("session.delete", { id });
    await persistenceOutbox.dropSession(id);
    // Drop the session's pi-agent so a later session with the same id (or a
    // stale runtime) can't answer with this session's context.
    if (sidecar) {
      sidecar.clearProjectInstructionRoot(id);
      sidecar.clearVendorAuthBindings(id);
      await sidecar
        .call("agent.disposeSession", { sessionId: id })
        .catch(() => undefined);
    }
    sessionProjects.delete(id);
    logger.app("session", "info", "session deleted", { sessionId: id });
    return res;
  });
  handle(IPC.invoke.sessionRename, async (id: string, title: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("session.rename", { id, title });
  });
  handle(
    IPC.invoke.sessionMoveProject,
    async (input: { sessionId?: string; projectPath?: string } = {}) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      const projectPath = String(input.projectPath ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!projectPath) {
        throw Object.assign(new Error("projectPath required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const releaseSessionOperation = await acquireSessionOperation(sessionId);
      try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot move a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      let result: { session?: (RuntimeSession & { projectPath?: string | null }) | null };
      try {
        result = await host.call("session.moveProject", { sessionId, projectPath });
      } catch (error: any) {
        // The durable running-turn guard can still reject a session whose turn
        // began between the check above and the host call.
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot move a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      const movedProjectPath = result.session.projectPath?.trim() || null;
      sessionProjects.set(sessionId, movedProjectPath);
      // The live pi-agent caches the project instruction root and vendor auth
      // bindings. Drop it after a successful move so the next turn is rebuilt
      // from the moved session's own project instead of the previous one.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
        if (movedProjectPath) {
          sidecar.setProjectInstructionRoot(sessionId, movedProjectPath);
        }
      }
      const { providers, defaults } = await sessionCapabilityContext();
      logger.app("session", "info", "session project moved", {
        sessionId,
        data: { projectPath: movedProjectPath },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
      } finally {
        releaseSessionOperation();
      }
    },
  );
  handle(
    IPC.invoke.sessionReplaceMessages,
    async (input: { sessionId: string; messages: unknown[] }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      // Drop the live pi-agent so the next prompt reseeds from the truncated
      // transcript instead of replaying the discarded branch in memory.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      return host.call("session.replaceMessages", {
        sessionId,
        messages: input.messages ?? [],
      });
    },
  );
  handle(
    IPC.invoke.sessionSaveRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      messages: unknown[];
      makeActive?: boolean;
    }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("session.saveRevision", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
        messages: input?.messages ?? [],
        makeActive: input?.makeActive === true,
      });
    },
  );
  handle(
    IPC.invoke.sessionListRevisions,
    async (input: { sessionId: string; rootUserId: string }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("session.listRevisions", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
      });
    },
  );
  handle(
    IPC.invoke.sessionActivateRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      revisionIndex: number;
      prefix?: unknown[];
    }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      return host.call("session.activateRevision", {
        sessionId,
        rootUserId: String(input?.rootUserId || ""),
        revisionIndex: Number(input?.revisionIndex || 0),
        prefix: input?.prefix ?? [],
      });
    },
  );
  handle(IPC.invoke.sessionGetScratchPath, async (input: { sessionId: string }) => {
    if (!host) throw new Error("host unavailable");
    return host.call<{ path: string }>("session.getScratchPath", {
      sessionId: String(input?.sessionId || ""),
    });
  });
  handle(IPC.invoke.sessionOpenScratchPath, async (input: { sessionId: string }) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = String(input?.sessionId || "").trim();
    const result = await host.call<{ path: string }>("session.getScratchPath", {
      sessionId,
    });
    const scratchPath = resolve(String(result?.path ?? ""));
    const scratchRoot = resolve(join(dataDir, "scratch"));
    const rel = relative(scratchRoot, scratchPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error("invalid session id"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    mkdirSync(scratchPath, { recursive: true });
    const openError = await shell.openPath(stripWinLongPrefix(scratchPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: scratchPath };
  });
  handle(
    IPC.invoke.sessionConfigure,
    async (
      id: string,
      config: {
        mode: Mode;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: ThinkingLevel;
        permissionMode?: "inherit" | "ask" | "accept-edits" | "auto";
      },
    ) => {
      if (!host) throw new Error("host unavailable");
      const result = await host.call<{ session?: RuntimeSession | null }>(
        "session.configure",
        { id, ...config },
      );
      if (!result.session) return result;
      const { providers, defaults } = await sessionCapabilityContext();
      const session = enrichSession(result.session, providers, defaults);
      if (
        config.providerId !== undefined ||
        config.modelId !== undefined ||
        config.thinkingLevel !== undefined
      ) {
        const modelKey =
          session.providerId && session.modelId
            ? `${session.providerId}/${session.modelId}`
            : null;
        plugins.broadcastEvent("session:modelChanged", [
          {
            sessionId: id,
            modelKey,
            thinkingLevel: session.thinkingLevel,
          },
        ]);
      }
      return { ...result, session };
    },
  );

  handle(IPC.invoke.sessionImportScan, async () => {
    const sessions = await scanAllSources();
    scannedImportSessions = new Map(
      sessions.map((session) => [`${session.source}:${session.externalId}`, session]),
    );
    return {
      sessions: sessions.map(({ filePath: _filePath, ...candidate }) => candidate),
    };
  });
  handle(
    IPC.invoke.sessionImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      for (const selection of items) {
        const key = importSelectionKey(selection);
        const item = key ? scannedImportSessions.get(key) : undefined;
        if (!item) {
          failed += 1;
          logger.app("session", "warn", "session import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        try {
          const converted = await convertSession(item);
          const res = await host.call<{ imported?: boolean }>("session.import", {
            session: converted.session,
            messages: converted.messages,
          });
          if (res.imported) imported += 1;
          else skipped += 1;
        } catch (e) {
          failed += 1;
          logger.app("session", "warn", "session import failed", {
            data: { source: item?.source, externalId: item?.externalId, error: String(e) },
          });
        }
      }
      logger.app("session", "info", "session import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

  handle(IPC.invoke.modelConfigImportScan, async () => {
    const drafts = await scanModelConfigs();
    scannedModelConfigs = new Map(
      drafts.map((draft) => [modelConfigImportKey(draft.source, draft.externalId), draft]),
    );
    return { providers: drafts.map(publicModelConfigCandidate) };
  });
  handle(
    IPC.invoke.modelConfigImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      const existing = await host.call<{
        providers: Array<{
          id: string;
          baseUrl?: string | null;
          apiStyle?: string | null;
          vendorKey?: string | null;
          hasSecret?: boolean;
        }>;
      }>("providers.list", { includeDisabled: true });
      // Matching an import by endpoint alone collapses distinct credentials.
      // Resolve existing API keys in Electron main so same-endpoint profiles
      // remain independent without exposing secrets to the renderer.
      const known = await Promise.all(
        (existing.providers ?? []).map(async (provider) => {
          let secretValue: string | undefined;
          if (provider.hasSecret) {
            try {
              secretValue = (
                await host!.call<{ value?: string }>("providers.getSecret", {
                  id: provider.id,
                })
              ).value;
            } catch {
              // A provider may only have an OAuth credential, or its secret
              // backend may be temporarily unavailable. In either case,
              // failing closed here avoids collapsing a new profile.
            }
          }
          return { ...provider, secretValue };
        }),
      );
      let firstImported:
        | { id: string; defaultModelId?: string; models?: Array<{ id: string }> }
        | undefined;
      for (const selection of items) {
        const key = modelConfigSelectionKey(selection);
        const draft = key ? scannedModelConfigs.get(key) : undefined;
        if (!draft) {
          failed += 1;
          logger.app("provider", "warn", "model config import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        if (draftMatchesExisting(draft, known)) {
          skipped += 1;
          continue;
        }
        try {
          const created = await host.call<{
            provider: { id: string; defaultModelId?: string; models?: Array<{ id: string }> };
          }>("providers.create", providerCreateInputFromDraft(draft));
          imported += 1;
          known.push({
            ...draft,
            id: created.provider.id,
            secretValue: draft.secretValue,
          });
          firstImported ??= created.provider;
        } catch (e) {
          failed += 1;
          logger.app("provider", "warn", "model config import failed", {
            data: {
              source: draft.source,
              externalId: draft.externalId,
              name: draft.name,
              hasSecret: draft.hasSecret,
              error: String(e),
            },
          });
        }
      }
      if (firstImported) {
        try {
          const settings = await host.call<{ defaultProviderId?: string }>("settings.get");
          if (!settings?.defaultProviderId) {
            await host.call("settings.set", {
              defaultProviderId: firstImported.id,
              defaultModelId:
                firstImported.models?.[0]?.id ?? firstImported.defaultModelId,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model config import default not set", {
            data: { error: String(e) },
          });
        }
      }
      logger.app("provider", "info", "model config import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });
  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });
  handle(IPC.invoke.settingsSet, async (settings: unknown) => {
    if (!host) throw new Error("host unavailable");
    const validatedSettings = validateSettingsWrite(settings);
    const result = await host.call("settings.set", validatedSettings);
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  });

  handle(IPC.invoke.commandShellList, async () => {
    return resolveEffectiveCommandShell();
  });

  handle(IPC.invoke.providersList, async () => {
    return enrichProviderList({ providers: await listRuntimeProviders() });
  });
  handle(IPC.invoke.providersRefreshModelCatalog, async () => {
    const refreshed = await modelsDevCatalog.refresh();
    return { refreshed, status: modelsDevCatalog.getStatus() };
  });
  // Status only: the snapshot is bundled with the release and this reports what
  // is loaded, so the settings footer never has to browse the catalog.
  handle(IPC.invoke.providersModelCatalogStatus, async () => {
    await modelsDevCatalog.ensureLoaded();
    return { status: modelsDevCatalog.getStatus() };
  });
  handle(IPC.invoke.providersCreate, async (input: unknown) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ provider: RuntimeProvider }>(
      "providers.create",
      input,
    );
    await modelsDevCatalog.ensureLoaded();
    return { ...result, provider: enrichProvider(result.provider) };
  });
  handle(IPC.invoke.providersUpdate, async (input: unknown) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ provider?: RuntimeProvider | null }>(
      "providers.update",
      input,
    );
    await modelsDevCatalog.ensureLoaded();
    return result.provider
      ? { ...result, provider: enrichProvider(result.provider) }
      : result;
  });
  handle(IPC.invoke.providersDelete, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("providers.delete", { id });
  });
  handle(IPC.invoke.providersTest, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    // Config-level validation first (secret present etc.)
    const local = await host.call<{ ok: boolean; message?: string }>(
      "providers.testConnection",
      { id },
    );
    if (!local.ok) return { ...local, network: "skipped" };
    const detail = await host.call<{
      provider?: { baseUrl?: string; authKind?: string; headers?: Record<string, string> };
    }>("providers.get", { id });
    // A vendor account proves itself by resolving auth — refreshing the token
    // if it has expired — not by probing /models with a key it does not have.
    if (detail.provider?.authKind === OAUTH_AUTH_KIND) {
      try {
        await vendorOAuth.resolveAuth(id);
        return { ok: true, network: "ok" };
      } catch (e) {
        return {
          ok: false,
          network: "failed",
          errorCode: ErrorCodes.PROVIDER_UNAUTHORIZED,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }
    const baseUrl = detail.provider?.baseUrl;
    if (!baseUrl) return { ...local, network: "skipped" };
    const secret = await host.call<{ value?: string }>("providers.getSecret", { id });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: mergeProviderHeaders(
          secret.value ? { Authorization: `Bearer ${secret.value}` } : {},
          detail.provider?.headers,
        ),
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          network: "failed",
          status: res.status,
          errorCode: ErrorCodes.PROVIDER_UNAUTHORIZED,
        };
      }
      if (res.status === 429) {
        return {
          ok: false,
          network: "failed",
          status: res.status,
          errorCode: ErrorCodes.PROVIDER_RATE_LIMITED,
        };
      }
      return { ok: res.ok, network: res.ok ? "ok" : "failed", status: res.status };
    } catch (e) {
      return {
        ok: false,
        network: "failed",
        errorCode: ErrorCodes.TIMEOUT,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      clearTimeout(timer);
    }
  });
  // Vendor-account login. The renderer drives the conversation but never sees
  // credential material: it gets progress events and a provider row id.
  handle(IPC.invoke.providersOauthVendors, async () => {
    return { vendors: await vendorOAuth.listVendors() };
  });
  handle(IPC.invoke.providersOauthStart, async (vendorId: unknown) => {
    if (typeof vendorId !== "string" || !vendorId) {
      throw new Error("vendorId required");
    }
    return vendorOAuth.start(vendorId);
  });
  handle(IPC.invoke.providersOauthRespond, async (input: unknown) => {
    const request = (input ?? {}) as OAuthRespondInput;
    if (!request.loginId || !request.promptId) {
      throw new Error("loginId and promptId required");
    }
    return { ok: vendorOAuth.respond(request) };
  });
  handle(IPC.invoke.providersOauthCancel, async (loginId: unknown) => {
    return { ok: typeof loginId === "string" && vendorOAuth.cancel(loginId) };
  });
  handle(IPC.invoke.providersOauthDelete, async (providerId: unknown) => {
    if (typeof providerId !== "string" || !providerId) {
      throw new Error("providerId required");
    }
    await vendorOAuth.deleteAccount(providerId);
    return { ok: true };
  });
  handle(
    IPC.invoke.providersListModels,
    async (
      input?:
        | string
          | {
            providerId?: string;
            baseUrl?: string;
            apiKey?: string;
            apiStyle?: string;
            headers?: Record<string, string>;
            source?: "cache" | "refresh";
          },
    ) => {
      if (!host) throw new Error("host unavailable");
      const req = typeof input === "string" ? { providerId: input } : input ?? {};
      const providers = req.source === "cache"
        ? (await host.call<{ providers: RuntimeProvider[] }>("providers.list", {
            includeDisabled: true,
          })).providers
        : await listRuntimeProviders();
      const provider = req.providerId
        ? providers.find((p) => p.id === req.providerId)
        : undefined;
      const baseUrl = (req.baseUrl ?? provider?.baseUrl ?? "").trim();
      const apiStyle = req.apiStyle ?? provider?.apiStyle ?? "chat_completions";
      // Cache hydration must stay fast; the renderer already requests a live
      // refresh after it has painted the cached list. Live requests load the
      // shared models.dev snapshot once; cache reads use only local files.
      if (req.source === "cache") {
        await modelsDevCatalog.loadLocal();
      } else {
        await modelsDevCatalog.ensureLoaded();
      }
      const decorate = (
        model: {
          modelId: string;
          displayName: string;
          capabilities?: string[];
          input?: readonly ("text" | "image")[];
          contextWindow?: number;
          maxTokens?: number;
          source?: "bundled" | "discovered" | "user";
        },
        // Vendor accounts can span wire APIs, so a model may need a style of
        // its own rather than the row's.
        modelApiStyle: string = apiStyle,
      ) => {
        const modelsDevModel = modelsDevCatalog.findModel({
          vendorKey: provider?.vendorKey || "custom",
          baseUrl,
          modelId: model.modelId,
        });
        const catalogModelConfig = modelsDevModel
          ? modelConfigFromModelsDev(modelsDevModel, baseUrl)
          : genericModelConfig(model.modelId, baseUrl);
        const storedModel = provider ? bindingForModel(provider, model.modelId) : undefined;
        const modelConfig = modelConfigWithBinding(catalogModelConfig, storedModel);
        const info = modelsDevModel
          ? modelInfoFromModelsDev(modelsDevModel, provider?.id ?? "")
          : {
              modelId: model.modelId,
              displayName: model.displayName,
              providerId: provider?.id ?? "",
              modalities: modelConfig.modalities,
              reasoning: false,
              capabilities: ["text"] as Array<"text" | "tools" | "vision" | "reasoning" | "json">,
              supportedThinkingLevels: [] as ThinkingLevel[],
              source: model.source ?? ("discovered" as const),
            };
        return {
          ...info,
          modelId: model.modelId,
          displayName: info.displayName || modelConfig.name,
          providerId: provider?.id ?? "",
          contextWindow: modelConfig.contextWindow,
          maxTokens: modelConfig.maxTokens,
          // Published modalities, taken before the binding is applied. This
          // record is what the settings panel compares its checkboxes against,
          // so letting a stored override shape it would make the override its
          // own justification and the panel could never show what models.dev
          // actually says.
          modalities: catalogModelConfig.modalities ?? { input: ["text"], output: ["text"] },
          // ModelInfo is catalog metadata. Keep its published reasoning fields
          // intact; Composer and runtime resolve the exact user binding when
          // they need effective per-provider capabilities.
          ...(modelsDevModel ? { catalogSource: "models.dev" as const } : {}),
        };
      };

      /*
        A configured model must carry its published record even when the live
        endpoint no longer lists it, because the settings panel reads image and
        PDF support from that record. Discovery stays the authority on what the
        service offers — these ids are only the ones the user already configured,
        never the catalog at large — so nothing new becomes selectable.
      */
      const withConfiguredBindings = <T extends { modelId: string }>(
        discovered: readonly T[],
      ): Array<T | ReturnType<typeof decorate>> => {
        if (!provider?.models?.length) return [...discovered];
        const seen = new Set(discovered.map((model) => model.modelId.toLowerCase()));
        const extra = provider.models
          .filter((binding) => !seen.has(binding.id.toLowerCase()))
          .map((binding) =>
            decorate({
              modelId: binding.id,
              displayName: binding.id,
              source: "user" as const,
            }),
          );
        return [...discovered, ...extra];
      };

      const cacheForCurrentProvider = async (models: unknown[]) => {
        if (!provider || req.source === "cache") return;
        const savedBaseUrl = (provider.baseUrl ?? "").trim().replace(/\/+$/, "");
        const requestBaseUrl = baseUrl.replace(/\/+$/, "");
        const usesSavedEndpoint =
          requestBaseUrl === savedBaseUrl &&
          apiStyle === (provider.apiStyle ?? "chat_completions");
        if (!usesSavedEndpoint) return;
        try {
          const latestProvider = (await listRuntimeProviders()).find(
            (candidate) => candidate.id === provider.id,
          );
          const endpointStillCurrent =
            (latestProvider?.baseUrl ?? "").trim().replace(/\/+$/, "") ===
              requestBaseUrl &&
            (latestProvider?.apiStyle ?? "chat_completions") === apiStyle;
          if (endpointStillCurrent) {
            await host!.call("providers.cacheModels", {
              providerId: provider.id,
              models,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model cache update failed", {
            data: {
              providerId: provider.id,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        }
      };

      // A signed-in vendor account has no key to probe /models with, and pi-ai
      // already knows which models the account may use (Copilot narrows the
      // list to the subscription).
      if (req.source !== "cache" && provider?.authKind === OAUTH_AUTH_KIND) {
        try {
          const options = await vendorOAuth.listModels(provider.id);
          if (options.length > 0) {
            return {
              models: withConfiguredBindings(
                options.map((option) =>
                  decorate(
                    {
                      modelId: option.modelId,
                      displayName: option.modelId,
                    },
                    option.apiStyle,
                  ),
                ),
              ),
              source: "remote" as const,
            };
          }
        } catch (e) {
          logger.app("provider", "warn", "vendor account model list failed", {
            data: {
              providerId: provider.id,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        }
      }

      if (req.source === "cache" && provider) {
        const cached = await host.call<{
          models: Array<{
            modelId: string;
            displayName: string;
            capabilities?: string[];
            contextWindow?: number;
            source?: "bundled" | "discovered" | "user";
          }>;
        }>("providers.listModels", { providerId: provider.id });
        // Keep every configured binding visible when the endpoint cache is
        // partial or empty. Decorating these ids through models.dev or generic
        // defaults preserves the per-model state for offline editing too.
        const cachedById = new Map(cached.models.map((model) => [model.modelId, model]));
        for (const binding of provider.models ?? []) {
          if (!cachedById.has(binding.id)) {
            cachedById.set(binding.id, {
              modelId: binding.id,
              displayName: binding.id,
              source: "user" as const,
            });
          }
        }
        if (cachedById.size > 0) {
          return {
            models: [...cachedById.values()].map((model) => decorate(model)),
            source: "cache" as const,
          };
        }
        const fallbackModelId = provider.defaultModelId;
        const fallback = fallbackModelId
          ? [decorate({
              modelId: fallbackModelId,
              displayName: fallbackModelId,
              source: "user",
            })]
          : [];
        return { models: fallback, source: "fallback" as const };
      }

      // Dialog edits can omit the key to reuse the stored secret; the raw key
      // never travels back to the renderer either way.
      let apiKey = req.apiKey ?? "";
      if (!apiKey && provider) {
        const secret = await host.call<{ value?: string }>("providers.getSecret", {
          id: provider.id,
        });
        apiKey = secret.value ?? "";
      }

      /*
        The service itself is the authority on which models it serves, so the
        live endpoint is asked first and models.dev is only consulted to enrich
        what came back (`decorate` above). Asking the catalog first would offer
        every published model for the vendor, including ones this deployment
        does not host and ones the key is not entitled to.
      */
      let discoveryError: string | undefined;
      if (baseUrl) {
        try {
          const discovered = await discoverProviderModels({
            baseUrl,
            apiKey,
            apiStyle,
            headers: req.headers ?? provider?.headers,
          });
          if (discovered.length > 0) {
            const models = discovered.map((model) => decorate(model));
            // Only what the endpoint actually served is cached; a configured id
            // it never offered must not be recorded as discovered.
            await cacheForCurrentProvider(models);
            return {
              models: withConfiguredBindings(models),
              source: "remote" as const,
            };
          }
        } catch (e) {
          discoveryError = e instanceof Error ? e.message : String(e);
          logger.app("provider", "warn", "model discovery failed", {
            data: { providerId: provider?.id, error: discoveryError },
          });
        }
      }

      // The endpoint published nothing usable (no /models route, an auth error,
      // or an empty list). The catalog is the fallback, not the primary source.
      const catalogModels = modelsDevCatalog.modelsForProvider({
        vendorKey: provider?.vendorKey,
        baseUrl,
        providerId: provider?.id ?? "",
      });
      if (catalogModels.length > 0) {
        return {
          models: withConfiguredBindings(
            catalogModels.map((model) => decorate(model)),
          ),
          source: "catalog" as const,
          ...(discoveryError ? { error: discoveryError } : {}),
        };
      }

      // Last resort: the provider's configured model, so pickers stay usable
      // for gateways without a /models endpoint.
      const fallbackModelId = provider?.models?.[0]?.id ?? provider?.defaultModelId;
      const fallback = fallbackModelId
        ? [decorate({ modelId: fallbackModelId, displayName: fallbackModelId })]
        : [];
      return { models: fallback, source: "fallback", error: discoveryError };
    },
  );

  // Secret material never crosses to the renderer: set/delete/has only.
  handle(IPC.invoke.secretsSet, async (input: { secretRef: string; value: string }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("secrets.set", {
      secretRef: input?.secretRef,
      value: input?.value,
    });
  });
  handle(IPC.invoke.secretsDelete, async (secretRef: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("secrets.delete", { secretRef });
  });
  handle(IPC.invoke.secretsHas, async (secretRef: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("secrets.has", { secretRef });
  });

  handle(IPC.invoke.projectGet, async () => {
    if (!host) throw new Error("host unavailable");
    let res = (await host.call("workspace.get")) as {
      workspace: { path: string; name: string } | null;
    };
    // Dev convenience only: never auto-open the app bundle directory as the
    // workspace in a packaged build.
    const seed =
      process.env.PI_DESKTOP_SEED_WORKSPACE ||
      process.env.PI_DESKTOP_WORKSPACE ||
      (isDevelopmentBuild ? join(__dirname, "../../..") : "");
    if (!res.workspace && seed) {
      try {
        res = (await host.call("workspace.set", { path: seed })) as {
          workspace: { path: string; name: string } | null;
        };
      } catch {
        // ignore seed failures
      }
    }
    return { workspace: await withGitBranch(res.workspace) };
  });
  handle(IPC.invoke.projectList, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("projects.list");
  });
  handle(IPC.invoke.projectOpenFolder, async (path: string) => {
    if (!host) throw new Error("host unavailable");
    const requestedPath = String(path ?? "").trim();
    if (!requestedPath) {
      throw Object.assign(new Error("project path required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // Open only known project records so the renderer cannot probe arbitrary
    // filesystem paths through this channel.
    const listed = (await host.call("projects.list")) as {
      projects?: Array<{ path?: string }>;
    };
    const projectPath = resolve(requestedPath);
    const known = (listed.projects ?? []).some((project) => {
      const candidate = String(project?.path ?? "").trim();
      return candidate && resolve(candidate) === projectPath;
    });
    if (!known) {
      throw Object.assign(new Error("project not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw Object.assign(new Error("folder not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const openError = await shell.openPath(stripWinLongPrefix(projectPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: projectPath };
  });
  handle(IPC.invoke.projectOpen, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { workspace: null, canceled: true };
    }
    const res = (await host.call("workspace.set", {
      path: result.filePaths[0],
    })) as { workspace: { path: string; name: string } | null };
    setCurrentWorkspacePath(res.workspace?.path ?? result.filePaths[0]);
    return { workspace: await withGitBranch(res.workspace), canceled: false };
  });
  handle(IPC.invoke.projectPickFolders, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "multiSelections", "createDirectory"],
    });
    return {
      folders: result.canceled ? [] : result.filePaths,
      canceled: result.canceled,
    };
  });
  handle(IPC.invoke.projectClone, async (input: { url?: string } = {}) => {
    const parentDefault = currentWorkspacePath()
      ? dirname(currentWorkspacePath()!)
      : homedir();
    const picked = await dialog.showOpenDialog({
      defaultPath: parentDefault,
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { workspace: null, canceled: true };
    }
    const dest = await cloneGitRepository({
      url: input.url ?? "",
      parentPath: picked.filePaths[0],
    });
    const workspace = await withGitBranch({
      path: dest,
      name: dest.split(/[\\/]/).filter(Boolean).at(-1) || dest,
    });
    return { workspace, canceled: false };
  });
  handle(IPC.invoke.projectSet, async (path: string) => {
    if (!host) throw new Error("host unavailable");
    setCurrentWorkspacePath(path);
    const res = (await host.call("workspace.set", { path })) as {
      workspace: { path: string; name: string } | null;
    };
    return { workspace: await withGitBranch(res.workspace) };
  });
  handle(IPC.invoke.projectClear, async () => {
    setCurrentWorkspacePath(null);
    if (!host) throw new Error("host unavailable");
    return host.call("workspace.clear");
  });

  handleWithEvent(IPC.invoke.composerPickFiles, async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { token: null, canceled: true };
    }
    return {
      token: rememberComposerPickerSelection(result.filePaths, event.sender.id),
      canceled: false,
    };
  });

  handleWithEvent(IPC.invoke.composerPickPhotos, async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { token: null, canceled: true };
    }
    return {
      token: rememberComposerPickerSelection(result.filePaths, event.sender.id),
      canceled: false,
    };
  });

  handleWithEvent(
    IPC.invoke.composerImportFiles,
    async (
      event,
      input: { sessionId?: unknown; token?: unknown } = {},
    ) => {
      if (!host) throw new Error("host unavailable");
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : "";
      if (!sessionId) {
        throw Object.assign(new Error("session required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const session = (await host.call("session.get", { id: sessionId })) as {
        session?: unknown;
      };
      if (!session.session) {
        throw Object.assign(new Error("session not found"), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      const paths = consumeComposerPickerSelection(input.token, event.sender.id);
      return {
        files: await importComposerFiles(
          dataDir,
          sessionId,
          paths,
        ),
      };
    },
  );

  handleWithEvent(
    IPC.invoke.clipboardRecordPaste,
    async (event, input: { text?: unknown } = {}) => {
      assertMainWindowSender(event);
      if (typeof input.text !== "string") {
        throw Object.assign(new Error("text must be a string"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      clipboardHistory.recordText(input.text);
      return { ok: true };
    },
  );

  handleWithEvent(
    IPC.invoke.composerPasteFiles,
    async (event, input: { sessionId?: unknown; files?: unknown } = {}) => {
      assertMainWindowSender(event);
      if (!host) throw new Error("host unavailable");
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : "";
      if (!sessionId) {
        throw Object.assign(new Error("session required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const session = (await host.call("session.get", { id: sessionId })) as {
        session?: unknown;
      };
      if (!session.session) {
        throw Object.assign(new Error("session not found"), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      if (!Array.isArray(input.files)) {
        throw Object.assign(new Error("files must be an array"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const files = input.files as ComposerPasteFile[];
      const saved = await saveComposerPasteFiles(dataDir, sessionId, files);
      recordPastedClipboardFiles(files);
      return { files: saved };
    },
  );

  handle(IPC.invoke.workspaceDiff, async () => {
    if (!host) throw new Error("host unavailable");
    const res = (await host.call("workspace.get")) as {
      workspace: { path: string } | null;
    };
    const cwd = res.workspace?.path;
    if (!cwd) {
      return { repo: false, clean: true, files: [] };
    }
    return collectWorkspaceDiff(cwd);
  });
  handle(
    IPC.invoke.workspaceReviewRollback,
    async (input: { sessionId: string; snapshotId: string }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("review.rollback", input);
    },
  );

  handle(
    IPC.invoke.statsGetTokenUsageHistory,
    async (input?: { startDate?: number; endDate?: number; bucket?: string }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("stats.getTokenUsageHistory", input ?? {});
    },
  );

  handle(
    IPC.invoke.browserNavigate,
    async (input: { url?: string; sessionId?: string } = {}) => {
      if (!plugins.getLoaded(BROWSER_PLUGIN_ID)) {
        throw Object.assign(new Error("Browser plugin is disabled"), {
          errorCode: "UNAVAILABLE",
        });
      }
      return browserHost.navigate(
        { url: String(input.url ?? "") },
        input.sessionId,
      );
    },
  );

  handle(IPC.invoke.browserAction, async (input: { action?: string } = {}) => {
    if (!plugins.getLoaded(BROWSER_PLUGIN_ID)) {
      throw Object.assign(new Error("Browser plugin is disabled"), {
        errorCode: "UNAVAILABLE",
      });
    }
    const action = String(input.action ?? "");
    if (
      action === "back" ||
      action === "forward" ||
      action === "reload" ||
      action === "stop"
    ) {
      browserHost.action(action);
    }
    return { ok: true };
  });

  handle(
    IPC.invoke.browserSetBounds,
    async () => {
      // Plugin chrome owns the clamped hole. Unclamped renderer bounds must
      // not place the guest over chat/composer.
      return { ok: true };
    },
  );

  handle(IPC.invoke.browserSetVisible, async (input: { visible?: boolean } = {}) => {
    if (!plugins.getLoaded(BROWSER_PLUGIN_ID) || input.visible !== true) {
      browserHost.setGuestVisible(BROWSER_PLUGIN_ID, false);
      return { ok: true };
    }
    browserHost.setGuestVisible(BROWSER_PLUGIN_ID, true);
    return { ok: true };
  });

  handle(IPC.invoke.browserOpenExternal, async (input: { url?: string } = {}) => {
    const raw = String(input.url ?? "").trim();
    if (raw) {
      const allowed = parseAllowedExternalUrl(raw);
      if (allowed) await shell.openExternal(allowed);
      return { ok: true };
    }
    browserHost.openExternal();
    return { ok: true };
  });

  handle(IPC.invoke.browserGetState, async () => {
    return browserHost.getState();
  });

  const requireWorkspaceRoot = async () => {
    if (!host) throw new Error("host unavailable");
    const res = (await host.call("workspace.get")) as {
      workspace: { path: string } | null;
    };
    const root = res.workspace?.path;
    if (!root) {
      throw Object.assign(new Error("workspace required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return root;
  };

  handle(IPC.invoke.fsList, async (input: { path?: string } = {}) => {
    const root = await requireWorkspaceRoot();
    return { entries: await listDir(root, String(input.path ?? "")) };
  });

  const fsExtraRoots = () => [
    join(dataDir, "scratch"),
    join(dataDir, "attachments"),
  ];

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    try {
      return await requireWorkspaceRoot();
    } catch {
      return null;
    }
  };

  handle(
    IPC.invoke.fsRead,
    async (input: { path?: string; mimeType?: string } = {}) => {
      const requested = String(input.path ?? "").trim();
      let workspaceRoot: string | null = null;
      try {
        workspaceRoot = await requireWorkspaceRoot();
      } catch (error) {
        if (!isAbsolute(requested) && !isAttachmentBlobRef(requested)) {
          throw error;
        }
      }
      return readOpenableFile(
        requested,
        workspaceRoot,
        fsExtraRoots(),
        input.mimeType,
      );
    },
  );

  handle(
    IPC.invoke.fsReadImageDataUrl,
    async (input: { ref?: string; mimeType?: string } = {}) => {
      const requested = String(input.ref ?? "").trim();
      return readOpenableImage(
        requested,
        await optionalWorkspaceRoot(),
        fsExtraRoots(),
        input.mimeType,
      );
    },
  );

  handle(IPC.invoke.fsReveal, async (input: { path?: string } = {}) => {
    const requested = String(input.path ?? "").trim();
    let workspaceRoot: string | null = null;
    try {
      workspaceRoot = await requireWorkspaceRoot();
    } catch (error) {
      if (!isAbsolute(requested) && !isAttachmentBlobRef(requested)) {
        throw error;
      }
    }
    const target = await resolveRealOpenablePath(
      requested,
      workspaceRoot,
      fsExtraRoots(),
    );
    if (!target) {
      throw Object.assign(new Error("path outside allowed roots"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    shell.showItemInFolder(stripWinLongPrefix(target));
    return { ok: true };
  });

  handle(IPC.invoke.fsOpen, async (input: { path?: string } = {}) => {
    const workspaceRoot = await optionalWorkspaceRoot();
    const target = resolveOpenablePath(String(input.path ?? ""), workspaceRoot, fsExtraRoots());
    if (!target) {
      throw Object.assign(new Error("path is not openable"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const openError = await shell.openPath(stripWinLongPrefix(target));
    if (openError) throw new Error(openError);
    return { ok: true };
  });

  // Composer input APIs (D123/D124, ADR 0024). Both fail soft: the menus
  // simply have less to show when the workspace or host is unavailable.
  let composerTemplateCache: {
    key: string;
    at: number;
    templates: ComposerTemplate[];
  } | null = null;
  const loadComposerTemplatesCached = async (
    root: string | null,
  ): Promise<ComposerTemplate[]> => {
    const key = root ?? "";
    const now = Date.now();
    if (
      composerTemplateCache &&
      composerTemplateCache.key === key &&
      now - composerTemplateCache.at < 5000
    ) {
      return composerTemplateCache.templates;
    }
    const { templates, diagnostics } = await loadComposerTemplates(root);
    for (const diagnostic of diagnostics) {
      logger.app("diagnostics", "warn", "composer template diagnostic", { data: diagnostic });
    }
    composerTemplateCache = { key, at: now, templates };
    return templates;
  };

  handle(IPC.invoke.fsIndex, async () => {
    const root = await optionalWorkspaceRoot();
    if (!root) return { entries: [], truncated: false };
    return getWorkspaceFileIndex(root);
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: () => mainWindow,
    importRoot: join(dataDir, "plugins", "imported"),
    loadDevPlugin: async (path) => {
      if (!host) throw new Error("host unavailable");
      const loaded = await host.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: async (input) => {
      if (!sidecar) throw new Error("agent sidecar unavailable");
      return sidecar.call<{ handled: boolean }>("extensions.command.run", input);
    },
  });

  const loadComposerSkillCommands = async (
    root: string | null,
  ): Promise<ComposerCommand[]> => {
    const builtins = builtinSkills({
      workspacePath: root,
      pluginPaths: plugins.listLoaded().map((loaded) => loaded.path),
    });
    const pluginSkills = plugins
      .getSkills()
      .filter((skill) => pluginActiveInProject(skill.pluginId, root))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      }));
    const userSkills = (await activeUserSkills(root ?? undefined)).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }));
    const seen = new Set<string>();
    return [...builtins, ...pluginSkills, ...userSkills].flatMap((skill) => {
      if (!skill.id || seen.has(skill.id)) return [];
      seen.add(skill.id);
      return [
        {
          name: skill.id,
          kind: "skill" as const,
          title: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          skillId: skill.id,
        },
      ];
    });
  };

  const buildComposerCommands = async (root: string | null): Promise<ComposerCommand[]> => {
    const templates = await loadComposerTemplatesCached(root).catch(() => []);
    const templateCommands = templates.map((template) => ({
      name: template.name,
      kind: "template" as const,
      title: template.name,
      ...(template.description ? { description: template.description } : {}),
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
      source: template.source,
    }));
    // App-facing surfaces scope against the *window's* project, not a session's:
    // this menu belongs to whatever folder is open in front of the user.
    const pluginCommands = plugins
      .getCommands()
      .filter((command) => pluginActiveInProject(command.pluginId, root))
      .map((command) => ({
        name: command.id,
        kind: "plugin" as const,
        title: command.title,
        ...(command.category ? { description: command.category } : {}),
        id: command.id,
      }));
    // Trusted extension commands take arguments and run in the active
    // session's sidecar (spec 16 §8); they come after plugin commands and
    // before the final Skills group.
    const extensionCommands = agentExtensions.allCommands().map((command) => ({
      name: command.name,
      kind: "extension" as const,
      title: `/${command.name}`,
      description: command.description ?? command.extensionLabel,
      id: trustedExtensionCommandId(command.name),
    }));
    const skillCommands = await loadComposerSkillCommands(root).catch(() => []);
    // One namespace: builtin aliases win, then project templates, then user
    // templates, then plugin commands, extension commands, and finally skills.
    // Skills are deliberately appended last so the slash menu keeps them at
    // the bottom without allowing a skill to shadow an existing command.
    const merged = new Map<string, ComposerCommand>();
    for (const command of [
      ...builtinComposerCommands(),
      ...templateCommands,
      ...pluginCommands,
      ...extensionCommands,
      ...skillCommands,
    ]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    return [...merged.values()];
  };

  handle(IPC.invoke.composerCommands, async () => {
    const root = await optionalWorkspaceRoot();
    return { commands: await buildComposerCommands(root) };
  });

  handle(
    IPC.invoke.windowSetWorkPanelReservation,
    async (input: unknown = {}) => {
      const requested = parseWorkPanelReservationWidth(input);
      if (requested === null) {
        throw Object.assign(new Error("invalid work panel reservation width"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error("main window unavailable");
      }

      // The work panel is an internal renderer column. Keep this IPC seam for
      // compatibility, but never let it change BrowserWindow bounds: opening
      // and collapsing the panel are handled entirely by renderer flex layout.
      requestedWorkPanelReservation = 0;
      workPanelReservation = emptyWorkPanelReservationState();
      return { requested: 0, reserved: 0 };
    },
  );

  handle(
    IPC.invoke.windowSetWorkPanelChatWidth,
    async (input: unknown = {}) => {
      const requested = parseWorkPanelChatWidth(input);
      if (requested === null) {
        throw Object.assign(new Error("invalid work panel chat width"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error("main window unavailable");
      }
      if (!setWorkPanelChatWidthForWindow || requestedWorkPanelReservation <= 0) {
        throw new Error("work panel unavailable");
      }
      const applied = setWorkPanelChatWidthForWindow(requested);
      return { requested, applied };
    },
  );

  handle(IPC.invoke.windowSetBackgroundColor, async (input: unknown = {}) => {
    const theme = (input as { theme?: unknown })?.theme;
    if (theme !== "light" && theme !== "dark") {
      throw Object.assign(new Error("invalid window background theme"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // macOS uses a transparent window with native sidebar vibrancy. Do not make
    // this renderer-driven fallback opaque on that platform.
    if (process.platform === "darwin") return { applied: false, theme };
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    mainWindow.setBackgroundColor(theme === "light" ? "#ffffff" : "#181818");
    return { applied: true, theme };
  });

  // Custom window-chrome buttons on Windows/Linux (renderer-drawn).
  handle(
    IPC.invoke.windowControl,
    async (input: { action?: string } = {}) => {
      if (
        !input.action ||
        !WINDOW_CONTROL_ACTIONS.includes(input.action as WindowControlAction)
      ) {
        throw new Error("unsupported window control action");
      }
      if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false };
      const window = mainWindow;
      switch (input.action as WindowControlAction) {
        case "getState":
          break;
        case "minimize":
          window.minimize();
          break;
        case "toggleMaximize":
          if (window.isMaximized()) window.unmaximize();
          else window.maximize();
          break;
        case "close":
          window.close();
          break;
      }
      return {
        maximized: !window.isDestroyed() && window.isMaximized(),
      };
    },
  );

  // Close-behavior preference (Windows/Linux): read/write the choice the
  // settings UI and the first-close prompt share. Only "tray" and "quit"
  // are settable — the "ask" state is transient (first close prompts once)
  // and once a choice is made it cannot be reverted to prompting.
  handle(IPC.invoke.closeBehaviorGet, async () => ({
    behavior: closeBehavior,
    supported: process.platform !== "darwin",
  }));

  handle(IPC.invoke.closeBehaviorSet, async (input: unknown = {}) => {
    // macOS keeps the native Dock lifecycle and has no close behavior to set.
    if (process.platform === "darwin") {
      throw Object.assign(new Error("close behavior is not configurable"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const behavior = (input as { behavior?: unknown })?.behavior;
    if (behavior !== "tray" && behavior !== "quit") {
      throw Object.assign(new Error("invalid close behavior"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    applyCloseBehavior(behavior);
    return { behavior };
  });

  ipcMain.handle(IPC.invoke.menuRendererReady, async (event) =>
    wrap(async () => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window !== mainWindow || !markMenuRendererReady(window)) {
        throw new Error("menu renderer is not attached to the main window");
      }
      return { ready: true };
    }),
  );

  handle(
    IPC.invoke.nativeMenuAction,
    async (input: { action?: string } = {}) => {
      if (
        !input.action ||
        !NATIVE_MENU_ACTIONS.includes(input.action as NativeMenuAction)
      ) {
        throw new Error("unsupported native menu action");
      }
      return executeNativeMenuAction(input.action as NativeMenuAction);
    },
  );

  handle(IPC.invoke.pullsList, async () => {
    if (!host) throw new Error("host unavailable");
    const res = (await host.call("workspace.get")) as {
      workspace: { path: string; name: string } | null;
    };
    const cwd = res.workspace?.path;
    if (!cwd) {
      return { pulls: [], error: "NO_WORKSPACE" as const };
    }
    const { spawn } = await import("node:child_process");
    const run = (cmd: string, args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(cmd, args, { cwd, env: process.env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.on("error", (err) =>
          resolve({ code: 1, stdout: "", stderr: String(err) }),
        );
      });
    const result = await run("gh", [
      "pr",
      "list",
      "--limit",
      "30",
      "--json",
      "number,title,url,author,headRefName,baseRefName,updatedAt,isDraft",
    ]);
    if (result.code !== 0) {
      return {
        pulls: [],
        error: result.stderr.trim() || result.stdout.trim() || "GH_FAILED",
      };
    }
    try {
      const pulls = JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>;
      return {
        pulls: pulls.map((p) => ({
          number: Number(p.number),
          title: String(p.title || ""),
          url: String(p.url || ""),
          author:
            typeof p.author === "object" && p.author
              ? String((p.author as any).login || "")
              : undefined,
          headRefName: p.headRefName ? String(p.headRefName) : undefined,
          baseRefName: p.baseRefName ? String(p.baseRefName) : undefined,
          updatedAt: p.updatedAt ? String(p.updatedAt) : undefined,
          isDraft: Boolean(p.isDraft),
        })),
      };
    } catch (e) {
      return { pulls: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  handle(IPC.invoke.scheduledList, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.list");
  });
  handle(IPC.invoke.scheduledCreate, async (input: any = {}) => {
    if (!host) throw new Error("host unavailable");
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("prompt required");
    return host.call("scheduled.create", { ...input, prompt });
  });
  handle(IPC.invoke.scheduledUpdate, async (input: any = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.update", input);
  });
  handle(IPC.invoke.scheduledDelete, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.delete", { id });
  });
  handle(IPC.invoke.scheduledRun, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{
      sessionId: string;
      prompt: string;
      task: unknown;
      runId: string;
    }>("scheduled.run", { id });
    // The renderer sends the prompt through the normal agent path; remember
    // the run so agent_end can close it via scheduled.finishRun.
    scheduledRunsBySession.set(res.sessionId, res.runId);
    return res;
  });

  handle(IPC.invoke.promptEnhance, async (req: PromptEnhancementRequest) => {
    if (!host) throw new Error("backend unavailable");
    const draft = typeof req?.draft === "string" ? req.draft : "";
    if (!draft.trim()) {
      throw Object.assign(new Error("Prompt draft must not be empty"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (draft.trim().startsWith("/")) {
      throw Object.assign(new Error("Slash command drafts cannot be enhanced"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }

    const sessionId =
      typeof req.sessionId === "string" ? req.sessionId.trim() : "";
    const session = sessionId
      ? (await host.call<{ session?: any }>("session.get", { id: sessionId })).session
      : {};
    if (sessionId && !session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launchSessionId = sessionId || `prompt-enhancement:${crypto.randomUUID()}`;
    const launch = await resolveAgentRuntimeLaunch(
      launchSessionId,
      session ?? {},
      settings,
      {
        mode: "agent",
        providerId:
          typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: req.thinkingLevel,
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;
    const enhancedDraft = await enhancePromptDraft(
      runtimeProvider,
      draft,
      launch.sidecarParams.thinkingLevel,
      { sessionId: launchSessionId },
    );
    logger.app("session", "info", "prompt enhanced", {
      sessionId: sessionId || undefined,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return { enhancedDraft };
  });

  handle(IPC.invoke.sessionSummarizeTitle, async (req: SessionSummarizeTitleRequest) => {
    if (!host) throw new Error("backend unavailable");
    const sessionId = typeof req?.sessionId === "string" ? req.sessionId.trim() : "";
    const userPrompt = typeof req?.userPrompt === "string" ? req.userPrompt.trim() : "";
    if (!sessionId || !userPrompt) {
      throw Object.assign(new Error("sessionId and userPrompt required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const session = (await host.call<{ session?: any }>("session.get", { id: sessionId })).session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launch = await resolveAgentRuntimeLaunch(
      `title-summary:${sessionId}`,
      session,
      settings,
      {
        mode: "agent",
        providerId: typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: "off",
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;

    const title = await summarizeSessionTitle(
      runtimeProvider,
      userPrompt,
      req.assistantReply,
      "off",
      { sessionId },
    );
    logger.app("session", "info", "session title summarized", {
      sessionId,
      data: { title, providerId: launch.providerId, modelId: launch.modelId },
    });
    return { title };
  });

  handle(IPC.invoke.agentPrompt, async (req: AgentPromptRequest) => {
    if (!host || !sidecar) throw new Error("backend unavailable");
    const releaseSessionOperation = await acquireSessionOperation(req.sessionId);
    try {
    // Install the renderer's prompt-time snapshot before any asynchronous
    // setup. This closes the gap where a fast completion could beat the
    // effect that reports the active chat session. Missing or mismatched
    // context is deliberately fail-safe.
    const requestedViewingSessionId =
      typeof req.viewingSessionId === "string" ? req.viewingSessionId.trim() : "";
    notificationViewingSessionId =
      requestedViewingSessionId && requestedViewingSessionId === req.sessionId
        ? requestedViewingSessionId
        : null;
    const settings = await host.call<any>("settings.get");
    const sessionResult = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
      messageLimit: 1,
    });
    let session = sessionResult.session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const truncateFromMessageId =
      typeof req.truncateFromMessageId === "string"
        ? req.truncateFromMessageId.trim()
        : "";
    const truncateBefore =
      typeof req.truncateBefore === "number" &&
      Number.isFinite(req.truncateBefore) &&
      req.truncateBefore >= 0
        ? Math.floor(req.truncateBefore)
        : undefined;
    if (truncateFromMessageId || truncateBefore !== undefined) {
      // Host-owned cut: the kept prefix never crosses the JSON-RPC pipe
      // (issue #211). Abort any leftover running turn first so beginTurn
      // cannot see AGENT_BUSY after a timed-out retry.
      if (sidecar) {
        await sidecar
          .call("agent.abort", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      await finishTurn(req.sessionId, "aborted", "TURN_ABORTED");

      try {
        await persistenceOutbox.flush(() => host);
        const truncated = await host.call<{
          revision?: {
            rootUserId?: string;
            revisionCount?: number;
            activeRevision?: number;
          } | null;
        }>("session.truncateFrom", {
          sessionId: req.sessionId,
          ...(truncateFromMessageId ? { fromMessageId: truncateFromMessageId } : {}),
          ...(truncateBefore !== undefined ? { truncateBefore } : {}),
        });
        const revision = truncated.revision;
        if (
          revision?.rootUserId &&
          typeof revision.revisionCount === "number" &&
          typeof revision.activeRevision === "number"
        ) {
          (req as any).__revisionMeta = {
            rootUserId: revision.rootUserId,
            revisionCount: revision.revisionCount,
            activeRevision: revision.activeRevision,
          };
        }
      } catch (error) {
        logger.app("persistence", "warn", "truncate regenerate transcript failed", {
          sessionId: req.sessionId,
          data: String(error),
        });
        throw error;
      }
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(req.sessionId);
        sidecar.clearVendorAuthBindings(req.sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      const refreshed = await host.call<{ session?: any }>("session.get", {
        id: req.sessionId,
        messageLimit: 1,
      });
      session = refreshed.session ?? session;
    }

    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);

    // Open a durable turn row, then persist the user message under it.
    const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
      sessionId: req.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    const durableTurnId = String(turn?.turnId ?? "").trim();
    if (!durableTurnId) {
      throw new Error("session.beginTurn returned no turn");
    }
    activeTurns.set(req.sessionId, durableTurnId);
    activeTurnUsages.delete(req.sessionId);

    // Slash expansion (D123, ADR 0024): templates expand before persistence
    // so reseed replays exactly what the model saw; the typed form rides along
    // as `command` for transcript display. Skill aliases are converted into a
    // short model instruction that makes the existing Skill tool call
    // explicit, while the typed form remains the visible transcript chip.
    // Builtin/plugin slash aliases never reach this channel, and unknown
    // /names stay literal text.
    let promptContent = req.content;
    let slashCommand: string | undefined;
    if (req.content.startsWith("/")) {
      try {
        const root = await optionalWorkspaceRoot();
        const commandEnd = req.content.search(/\s/);
        const commandName = req.content.slice(
          1,
          commandEnd === -1 ? undefined : commandEnd,
        );
        const commands = await buildComposerCommands(launch.projectPath ?? root);
        const command = commands.find((item) => item.name === commandName);
        if (command?.kind === "skill" && command.skillId) {
          const body = commandEnd === -1 ? "" : req.content.slice(commandEnd).trim();
          promptContent = [
            `Call the \`Skill\` tool with id ${JSON.stringify(command.skillId)} before answering this request. Follow the loaded skill instructions.`,
            body,
          ]
            .filter(Boolean)
            .join("\n\n");
          slashCommand = req.content;
        } else {
          const templates = await loadComposerTemplatesCached(root);
          const expansion = expandSlashInvocation(req.content, templates);
          if (expansion) {
            promptContent = expansion.expanded;
            slashCommand = expansion.command;
          }
        }
      } catch (error) {
        logger.app("session", "warn", "slash expansion failed; sending literal text", {
          sessionId: req.sessionId,
          data: String(error),
        });
      }
    }

    // The binding's image override already shaped this modelConfig, so the
    // transport gate and the settings switch cannot disagree.
    const supportsVision = visionFromModelConfig(
      launch.sidecarParams.provider.modelConfig,
    );
    let preparedAttachments: PreparedPromptAttachment[];
    try {
      preparedAttachments = await preparePromptAttachments(
        dataDir,
        req.sessionId,
        typeof session.projectPath === "string" && session.projectPath.trim()
          ? session.projectPath.trim()
          : undefined,
        req.attachments ?? [],
        supportsVision,
      );
    } catch (error) {
      await finishTurn(req.sessionId, "error", (error as any)?.errorCode);
      throw error;
    }
    const modelContent = appendPromptFallbackPaths(
      promptContent,
      preparedAttachments,
    );

    // Persist user message
    const revisionMeta = (req as any).__revisionMeta as
      | {
          rootUserId?: string;
          revisionCount?: number;
          activeRevision?: number;
        }
      | undefined;
    // The renderer already shows this row under its own id (D288); persisting
    // and echoing under the same id lets the echo replace it in place.
    const userMessage = {
      id: durableUserMessageId(
        req.messageId,
        Array.isArray(session.messages) ? session.messages : [],
      ),

      role: "user" as const,
      content: promptContent,
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      ...(preparedAttachments.length
        ? { attachments: preparedAttachments.map((attachment) => attachment.message) }
        : {}),
      ...(slashCommand ? { command: slashCommand } : {}),
      ...(revisionMeta?.revisionCount
        ? {
            revisionRootId: revisionMeta.rootUserId,
            revisionCount: revisionMeta.revisionCount,
            activeRevision: revisionMeta.activeRevision,
          }
        : {}),
    };
    try {
      await host.call("session.appendMessage", {
        sessionId: req.sessionId,
        message: userMessage,
        turnId: durableTurnId,
      });
    } catch (error) {
      await finishTurn(
        req.sessionId,
        "error",
        (error as { data?: { errorCode?: string }; errorCode?: string })?.data
          ?.errorCode ??
          (error as { errorCode?: string })?.errorCode,
      );
      throw error;
    }
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_start", message: userMessage },
    } satisfies AgentEventEnvelope);
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_end", message: userMessage },
    } satisfies AgentEventEnvelope);

    let result: { accepted: boolean; turnId: string };
    try {
      result = await sidecar.call<{ accepted: boolean; turnId: string }>(
        "agent.prompt",
        {
          ...launch.sidecarParams,
          // The host-created durable turn is the approval identity used by
          // Rust. The runtime must not replace it with a provider-local UUID.
          turnId: durableTurnId,
          content: modelContent,
          attachments: preparedAttachments
            .filter((attachment) => attachment.inlineData)
            .map((attachment) => ({
              path: attachment.message.ref,
              name: attachment.message.name,
              kind: attachment.message.kind,
              mimeType: attachment.message.mimeType,
              size: attachment.message.size,
              data: attachment.inlineData,
            })),
          userMessageId: userMessage.id,
        },
      );
    } catch (e) {
      await finishTurn(req.sessionId, "error", (e as any)?.errorCode);
      throw e;
    }
    logger.app("session", "info", "prompt accepted", {
      sessionId: req.sessionId,
      turnId: result.turnId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
    } finally {
      releaseSessionOperation();
    }
  });

  handle(IPC.invoke.agentCompact, async (req: { sessionId: string }) => {
    if (!host || !sidecar) throw new Error("backend unavailable");
    if (activeTurns.has(req.sessionId)) {
      throw Object.assign(new Error("Session already has an active turn"), {
        errorCode: ErrorCodes.AGENT_BUSY,
      });
    }
    const settings = await host.call<any>("settings.get");
    const detail = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
    });
    if (!detail.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      detail.session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);
    const result = await sidecar.call("agent.compact", launch.sidecarParams);
    logger.app("session", "info", "context compacted manually", {
      sessionId: req.sessionId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
  });

  handle(IPC.invoke.agentAbort, async (req: { sessionId: string }) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    logger.app("session", "info", "prompt aborted", { sessionId: req.sessionId });
    agentHostBridge?.markAborting(req.sessionId);
    const executionId =
      approvedExecutionIdsBySession.get(req.sessionId) ??
      [...claimedExecutionSessions].find(
        ([, sessionId]) => sessionId === req.sessionId,
      )?.[0];
    let result: unknown;
    try {
      // An open extension prompt resolves with its abort value (spec 16 §9).
      agentExtensions.cancelPrompts(req.sessionId);
      result = await sidecar.call("agent.abort", req);
    } finally {
      await finishTurn(req.sessionId, "aborted", "TURN_ABORTED");
      if (executionId) {
        await finishApprovedExecution(
          executionId,
          "interrupted",
          "PLAN_EXECUTION_INTERRUPTED",
        );
      }
    }
    return result;
  });

  handle(IPC.invoke.agentStop, async (req: AgentStopRequest) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    logger.app("session", "info", "prompt graceful stop requested", {
      sessionId: req.sessionId,
    });
    // The runtime owns the boundary decision. Do not close the durable turn
    // here: agent_end must arrive after the current reply/tool batch completes
    // and finish it as a normal completed turn.
    return sidecar.call("agent.stop", req);
  });

  handle(IPC.invoke.agentGetStatus, async (sessionId: string) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    return sidecar.call("agent.getStatus", { sessionId });
  });

  // The Host-owned turn queue (D375 / D386). The renderer mirrors it; the
  // headless module admits, orders, and drains it.
  handle(IPC.invoke.agentQueuePush, async (req: AgentQueuePushRequest) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return agentHostBridge.queue.push(req);
  });
  handle(IPC.invoke.agentQueueList, async (req: { sessionId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return { entries: agentHostBridge.queue.list(req.sessionId) };
  });
  handle(IPC.invoke.agentQueueRemove, async (req: { turnId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.remove(req.turnId);
    return { ok: true };
  });
  handle(IPC.invoke.agentQueuePrioritize, async (req: { turnId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.prioritize(req.turnId);
    return { ok: true };
  });

  handle(IPC.invoke.toolResolvePermission, async (resolution: {
    requestId: string;
    decision: string;
  }) => {
    if (!host) throw new Error("host unavailable");
    logger.app("permission", "info", "permission resolved", {
      data: { requestId: resolution.requestId, decision: resolution.decision },
    });
    const resolved = await host.call("permissions.resolve", resolution);
    agentHostBridge?.settleApproval(resolution.requestId, {
      ...(resolution.decision === "allow-once" ||
      resolution.decision === "allow-session" ||
      resolution.decision === "deny"
        ? { decision: resolution.decision }
        : {}),
    });
    return resolved;
  });

  handle(IPC.invoke.askToolResolve, async (resolution: AskToolResolution) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    const requestId = String(resolution?.requestId ?? "").trim();
    if (!sessionId || !requestId) throw new Error("asktool resolution identity required");
    return sidecar.call("asktool.resolve", {
      ...resolution,
      sessionId,
      requestId,
    });
  });

  handle(IPC.invoke.plansPending, async (input: { sessionId?: string } = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plans.pending", {
      ...(typeof input.sessionId === "string" && input.sessionId.trim()
        ? { sessionId: input.sessionId.trim() }
        : {}),
    });
  });

  handle(IPC.invoke.plansResolve, async (resolution: PlanResolveRequest) => {
    if (!host) throw new Error("host unavailable");
    const proposalId = String(resolution?.proposalId ?? "").trim();
    if (!proposalId) throw new Error("proposalId required");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    if (!sessionId) throw new Error("sessionId required");
    const turnId = String(resolution?.turnId ?? "").trim();
    if (!turnId) throw new Error("turnId required");
    const toolCallId = String(resolution?.toolCallId ?? "").trim();
    if (!toolCallId) throw new Error("toolCallId required");
    const action = resolution?.action;
    if (action !== "approve" && action !== "reject") {
      throw new Error("invalid plan approval action");
    }
    let targetPermissionMode: GlobalPermissionMode | undefined;
    if (action === "approve") {
      if (!isGlobalPermissionMode(resolution?.targetPermissionMode)) {
        throw Object.assign(new Error("targetPermissionMode is required for approval"), {
          errorCode: ErrorCodes.PLAN_PERMISSION_MODE_REQUIRED,
        });
      }
      targetPermissionMode = resolution.targetPermissionMode;
    }
    const version =
      typeof resolution?.version === "number" &&
      Number.isSafeInteger(resolution.version) &&
      resolution.version > 0
        ? resolution.version
        : undefined;
    const result = await host.call<PlanResolutionResult>("plans.resolve", {
      proposalId,
      sessionId,
      turnId,
      toolCallId,
      action,
      ...(version !== undefined ? { version } : {}),
      ...(targetPermissionMode ? { targetPermissionMode } : {}),
    });
    agentHostBridge?.settleApproval(proposalId, {
      decision: action,
      ...(targetPermissionMode ? { permissionMode: targetPermissionMode } : {}),
    });
    if (action === "approve") {
      const execution = executionFromResponse(result);
      if (execution) {
        void dispatchApprovedPlan(execution);
      } else {
        void dispatchExecutionForProposal(proposalId);
      }
    }
    return result;
  });

  handle(IPC.invoke.pluginList, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ plugins: any[] }>("plugins.list");
    rememberPluginScopes(result.plugins ?? []);
    const pluginsWithSettings = await Promise.all(
      (result.plugins ?? []).map(async (plugin) => {
        const extensionIds = plugins
          .getAgentExtensions()
          .filter((extension) => extension.pluginId === plugin?.id)
          .map((extension) => extension.id);
        const withExtension = extensionIds.length
          ? { ...plugin, agentExtension: agentExtensions.statusForPlugin(extensionIds) }
          : plugin;
        if (!plugin?.settings?.length || !plugins.getLoaded(plugin.id)) return withExtension;
        try {
          const settings = await plugins.getPluginSettings(plugin.id);
          return { ...withExtension, settings };
        } catch {
          return withExtension;
        }
      }),
    );
    return { ...result, plugins: pluginsWithSettings };
  });

  handle(IPC.invoke.pluginSettingsGet, async (id: string) => {
    const settings = await plugins.getPluginSettings(String(id ?? ""));
    return { settings };
  });

  handle(
    IPC.invoke.pluginSettingsSet,
    async (payload: { id?: string; settings?: Record<string, unknown> }) => {
      const settings = await plugins.setPluginSettings(
        String(payload?.id ?? ""),
        payload?.settings ?? {},
      );
      sendToRenderer(IPC.event.pluginChanged,{
        reason: "settings",
        pluginId: String(payload?.id ?? ""),
      });
      return { settings };
    },
  );

  handle(IPC.invoke.pluginLoadDev, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    const loaded = await host.call<{ plugin: any }>("plugins.loadDev", { path });
    await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], {
      development: true,
    });
    if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "loadDev",
      pluginId: loaded.plugin?.id,
    });
    return loaded;
  });

  handle(IPC.invoke.pluginReload, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const listed = await host.call<{ plugins: any[] }>("plugins.list");
    const plugin = (listed.plugins ?? []).find((candidate) => candidate?.id === id);
    if (!plugin?.path) throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
    await plugins.loadFromPath(plugin.path, plugin.permissions ?? [], {
      development: plugin.source === "dev",
    });
    if (plugin.source === "dev") plugins.watchDevPlugin(id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{ reason: "reload", pluginId: id });
    return { plugin };
  });

  // Scaffold a starter plugin and load it as a dev plugin in one step (D171),
  // so "I want to write a plugin" never starts with an empty folder.
  handle(
    IPC.invoke.pluginCreateFromTemplate,
    async (req: { template?: string }) => {
      if (!host) throw new Error("host unavailable");
      const template = req?.template;
      if (!isTemplateName(template)) {
        throw new Error(`unknown plugin template: ${String(template)}`);
      }
      const picked = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true };
      }
      const dir = picked.filePaths[0];
      const created = await scaffold({ dir, template });
      const loaded = await host.call<{ plugin: any }>("plugins.loadDev", {
        path: dir,
      });
      await plugins.loadFromPath(dir, loaded.plugin?.permissions ?? [], {
        development: true,
      });
      plugins.watchDevPlugin(created.id);
      for (const toast of plugins.drainToasts()) {
        sendToRenderer(IPC.event.toast, { message: toast });
      }
      return {
        id: created.id,
        name: created.name,
        dir: created.dir,
        files: created.files,
      };
    },
  );

  handle(IPC.invoke.pluginInstallFromPath, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    const installed = await host.call<{ result: any }>("plugins.installFromPath", {
      path,
      enable: true,
    });
    if (installed.result?.plugin?.enabled && installed.result?.plugin?.path) {
      await plugins.loadFromPath(
        installed.result.plugin.path,
        installed.result.plugin.permissions ?? [],
      );
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "install",
      pluginId: installed.result?.plugin?.id,
    });
    return installed;
  });

  handle(IPC.invoke.pluginInstallFromPackage, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "PI Plugin", extensions: ["piplug", "zip"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    const installed = await host.call<{ result: any }>("plugins.installFromPackage", {
      path,
      enable: true,
    });
    if (installed.result?.plugin?.enabled && installed.result?.plugin?.path) {
      await plugins.loadFromPath(
        installed.result.plugin.path,
        installed.result.plugin.permissions ?? [],
      );
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "install",
      pluginId: installed.result?.plugin?.id,
    });
    return installed;
  });

  handle(IPC.invoke.pluginEnable, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ plugin: any }>("plugins.enable", { id });
    if (res.plugin?.path) {
      await plugins.loadFromPath(res.plugin.path, res.plugin.permissions ?? [], {
        development: res.plugin.source === "dev",
      });
      if (res.plugin.source === "dev") plugins.watchDevPlugin(id);
    }
    logger.app("plugin", "info", "plugin enabled", { pluginId: id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "enable", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginDisable, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    pluginViews.closePlugin(id);
    if (id === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
    await plugins.unload(id);
    logger.app("plugin", "info", "plugin disabled", { pluginId: id });
    const res = await host.call("plugins.disable", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "disable", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginUninstall, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    pluginViews.closePlugin(id);
    await plugins.unload(id);
    logger.app("plugin", "info", "plugin uninstalled", { pluginId: id });
    const res = await host.call("plugins.uninstall", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "uninstall", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginSetAutoUpdate, async (payload: { id: string; enabled: boolean }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plugins.setAutoUpdate", {
      id: payload.id,
      enabled: payload.enabled,
    });
  });

  handle(
    IPC.invoke.pluginSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call<{ plugin?: { id?: string; scope?: ActivationScope } }>(
        "plugins.setScope",
        { id: payload.id, scope: payload.scope },
      );
      // Keep the dispatch-path cache honest without waiting for the next list.
      if (res.plugin?.id && res.plugin.scope) {
        pluginScopes.set(res.plugin.id, res.plugin.scope);
      }
      logger.app("plugin", "info", "plugin scope changed", {
        pluginId: payload.id,
        data: { mode: payload.scope?.mode, projects: payload.scope?.projects?.length ?? 0 },
      });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "scope", pluginId: payload.id });
      return res;
    },
  );

  // --- MCP servers the user owns -------------------------------------------
  // host-core persists and validates; this side owns the connections, so every
  // mutation is followed by a refresh that drops stale ones.

  handle(IPC.invoke.mcpList, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ servers: McpServerRecord[]; statuses?: McpServerStatus[] }>(
      "mcp.list",
      query,
    );
    // Status belongs to the currently open project's active runtime, while the
    // list itself must include disabled records for the settings page.
    await refreshUserMcp(currentWorkspacePath());
    return { servers: result.servers ?? [], statuses: userMcp.listStatuses() };
  });

  handle(IPC.invoke.mcpUpsert, async (server: McpServerInput) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
    await refreshUserMcp(currentWorkspacePath());
    sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: res.server?.id });
    return res;
  });

  handle(
    IPC.invoke.mcpRemove,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.remove", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpSetEnabled,
    async (payload: { id: string; enabled: boolean } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.setEnabled", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.setScope", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpTest,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const query = {
        ...(payload.level ? { level: payload.level } : {}),
        ...(payload.projectPath ? { projectPath: payload.projectPath } : {}),
      } satisfies Partial<AgentCapabilityQuery>;
      const listed = await host.call<{ servers: McpServerRecord[] }>("mcp.list", query);
      // Test may target a project different from the current session. Keep the
      // requested record long enough for the handshake, then restore the
      // current project's active runtime below.
      userMcp.setRecords([
        ...userMcp.listRecords().filter((record) => !listed.servers.some((item) => item.id === record.id)),
        ...(listed.servers ?? []),
      ]);
      const status = await userMcp.test(payload.id);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return { status };
    },
  );

  /**
   * Import a pasted MCP configuration. Servers are saved one at a time so a
   * single bad entry costs that entry rather than the whole paste.
   */
  handle(IPC.invoke.mcpImport, async (payload: { text: string }) => {
    if (!host) throw new Error("host unavailable");
    const parsed = parseMcpImport(String(payload?.text ?? ""));
    const imported: McpServerRecord[] = [];
    const failed = [...parsed.skipped];
    for (const server of parsed.servers) {
      try {
        const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
        imported.push(res.server);
      } catch (error) {
        failed.push({ id: server.id, reason: describeError(error) });
      }
    }
    await refreshUserMcp(currentWorkspacePath());
    if (imported.length) {
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp" });
    }
    return { imported, failed };
  });

  // --- Skills the user owns -------------------------------------------------

  handle(IPC.invoke.skillList, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("skills.list", query);
  });

  handle(IPC.invoke.skillCreate, async (skill: Record<string, unknown>) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("skills.create", { skill });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  /** Import exactly one markdown file into the selected capability directory. */
  handle(IPC.invoke.skillImport, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    const picked = await dialog.showOpenDialog({
      title: "Import skill",
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const res = await host.call("skills.import", {
      path: picked.filePaths[0],
      ...query,
    });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  handle(
    IPC.invoke.skillUpdate,
    async (payload: { id: string } & Record<string, unknown>) => {
      if (!host) throw new Error("host unavailable");
      const { id, ...skill } = payload;
      const res = await host.call("skills.update", { id, skill });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillRead,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      return host.call("skills.read", request);
    },
  );

  handle(
    IPC.invoke.skillRemove,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      const res = await host.call("skills.remove", request);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillSetEnabled,
    async (payload: { id: string; enabled: boolean } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("skills.setEnabled", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("skills.setScope", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  /**
   * Show a skill document in the OS file manager. The level and project travel
   * with the id because `skills.read` falls back to the global directory when
   * they are absent, which never resolves a project-only document.
   */
  handle(
    IPC.invoke.skillReveal,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      const res = await host.call<{ skill: UserSkillRecord | null }>("skills.read", request);
      const path = res.skill?.path;
      if (!path) throw new Error("skill not found");
      shell.showItemInFolder(stripWinLongPrefix(path));
      return { ok: true };
    },
  );

  // --- Subagents the user owns ----------------------------------------------

  handle(IPC.invoke.subagentList, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("agents.list");
  });

  /**
   * The effective catalog: what `Task` would actually offer right now, merged
   * across builtin, registry and project documents. The renderer needs this to
   * show read-only rows and to name the definition that wins each handle.
   */
  handle(IPC.invoke.subagentCatalog, async () => {
    const projectPath = (await optionalWorkspaceRoot()) ?? undefined;
    const { definitions, diagnostics } = await loadSubagentDefinitions(
      projectPath,
      { userDocuments: await activeUserSubagentDocuments(projectPath) },
    );
    return { subagents: definitions, diagnostics, projectPath: projectPath ?? null };
  });

  handle(IPC.invoke.subagentCreate, async (subagent: Record<string, unknown>) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("agents.create", { subagent });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
    return res;
  });

  handle(
    IPC.invoke.subagentUpdate,
    async (payload: { id: string } & Record<string, unknown>) => {
      if (!host) throw new Error("host unavailable");
      const { id, ...subagent } = payload;
      const res = await host.call("agents.update", { id, subagent });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  handle(IPC.invoke.subagentRead, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("agents.read", { id });
  });

  handle(IPC.invoke.subagentRemove, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("agents.remove", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
    return res;
  });

  handle(
    IPC.invoke.subagentSetEnabled,
    async (payload: { id: string; enabled: boolean }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("agents.setEnabled", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  handle(
    IPC.invoke.subagentSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("agents.setScope", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  /**
   * Show a definition document in the OS file manager. The path always comes
   * from the host registry: a renderer-supplied path is never handed to the
   * shell, so this channel cannot be used to reveal arbitrary locations.
   */
  handle(IPC.invoke.subagentReveal, async (payload: { id?: string; path?: string }) => {
    if (!host) throw new Error("host unavailable");
    if (!payload.id) throw new Error("subagent id required");
    const res = await host.call<{ subagent: UserSubagentRecord | null }>(
      "agents.read",
      { id: payload.id },
    );
    const path = res.subagent?.path;
    if (!path) throw new Error("subagent not found");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { ok: true };
  });

  handle(IPC.invoke.pluginOpenPanel, async (id: string) => {
    const loaded = plugins.getLoaded(id);
    if (!loaded) throw new Error("plugin not loaded");
    const manifest = loaded.manifest;
    if (!manifest.ui?.panel) throw new Error("plugin has no panel");
    if (!(loaded.permissions.has("ui.panel"))) {
      throw new Error("PERMISSION_DENIED: ui.panel");
    }
    const htmlPath = resolveInsidePluginRoot(loaded.path, manifest.ui.panel);
    if (!htmlPath) throw new Error("plugin panel must stay inside the plugin");
    await pluginPanels.open({
      pluginId: id,
      title: resolvePluginLocalizedString(manifest.ui.title, updaterLocale, manifest.name),
      locale: updaterLocale,
      theme: pluginPanelTheme,
      width: manifest.ui.width ?? 480,
      height: manifest.ui.height ?? 360,
      htmlPath,
    });
    return { ok: true };
  });

  /**
   * Work panel views a plugin contributes (ADR 0104).
   *
   * Unlike `pluginThemes`, this list *is* filtered by activation scope: a theme
   * is one global app setting, but a view is something the plugin does inside a
   * project, so a project-scoped plugin must not offer its view elsewhere.
   */
  handle(IPC.invoke.pluginViews, async () => {
    const workspacePath = currentWorkspacePath();
    const views: PluginViewMeta[] = [];
    for (const loaded of plugins.listLoaded()) {
      const pluginId = loaded.manifest.id;
      if (!loaded.permissions.has("ui.view")) continue;
      if (!pluginActiveInProject(pluginId, workspacePath)) continue;
      const contributed = loaded.manifest.contributes?.views ?? [];
      contributed.forEach((view, index) => {
        if (!view?.id || !view.entry) return;
        // The manifest is validated at install, but a development plugin's
        // files change under us; a missing entry must not become a blank pane.
        if (!existsSync(join(loaded.path, view.entry))) return;
        views.push({
          pluginId,
          viewId: view.id,
          ref: pluginViewKey(pluginId, view.id),
          title: resolvePluginLocalizedString(view.title, updaterLocale, view.id),
          pluginName: loaded.manifest.name,
          icon: view.icon,
          order: Number.isFinite(view.order) ? Number(view.order) : index,
        });
      });
    }
    // Stable order across refreshes: declared order first, then plugin name, so
    // the menu never reshuffles under the pointer when an unrelated plugin
    // loads.
    return views.sort(
      (a, b) =>
        a.order - b.order ||
        a.pluginName.localeCompare(b.pluginName) ||
        a.viewId.localeCompare(b.viewId),
    );
  });

  handle(
    IPC.invoke.pluginViewOpen,
    async (payload: {
      pluginId?: string;
      viewId?: string;
      sessionId?: string;
      location?: string;
    }) => {
      const pluginId = String(payload?.pluginId ?? "");
      const viewId = String(payload?.viewId ?? "");
      const sessionId = String(payload?.sessionId ?? "").trim();
      const location = String(payload?.location ?? "").trim();
      const isBrowserView = pluginId === BROWSER_PLUGIN_ID && viewId === BROWSER_VIEW_ID;
      if (isBrowserView && sessionId) browserHost.setChromeSession(sessionId);
      if (isBrowserView && sessionId && location) {
        browserHost.rememberLocation(sessionId, location);
      }
      const loaded = plugins.getLoaded(pluginId);
      if (!loaded) throw new Error("plugin not loaded");
      if (!loaded.permissions.has("ui.view")) {
        throw new Error("PERMISSION_DENIED: ui.view");
      }
      if (!pluginActiveInProject(pluginId, currentWorkspacePath())) {
        throw new Error("plugin is not active in this project");
      }
      const view = (loaded.manifest.contributes?.views ?? []).find(
        (candidate) => candidate?.id === viewId,
      );
      if (!view) throw new Error("plugin has no such view");
      const htmlPath = join(loaded.path, view.entry);
      if (!existsSync(htmlPath)) throw new Error("view entry missing");
      pluginViews.open({
        pluginId,
        viewId,
        locale: updaterLocale,
        theme: pluginPanelTheme,
        htmlPath,
        netDomains: loaded.manifest.net?.domains?.map((domain) => String(domain)),
      });
      if (isBrowserView && location) {
        void browserHost.navigate(
          { path: location, url: location },
          sessionId || undefined,
        );
      }
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.pluginViewClose,
    async (payload: { pluginId?: string; viewId?: string }) => {
      pluginViews.close(String(payload?.pluginId ?? ""), String(payload?.viewId ?? ""));
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.pluginViewSetBounds,
    async (payload: { x: number; y: number; width: number; height: number }) => {
      pluginViews.setBounds(payload ?? { x: 0, y: 0, width: 0, height: 0 });
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.pluginViewSetVisible,
    async (payload: {
      pluginId?: string;
      viewId?: string;
      visible?: boolean;
      sessionId?: string;
    }) => {
      const pluginId = String(payload?.pluginId ?? "");
      const viewId = String(payload?.viewId ?? "");
      const sessionId = String(payload?.sessionId ?? "").trim();
      if (
        payload?.visible === true &&
        sessionId &&
        pluginId === BROWSER_PLUGIN_ID &&
        viewId === BROWSER_VIEW_ID
      ) {
        browserHost.setChromeSession(sessionId);
      }
      pluginViews.setVisible(pluginId, viewId, payload?.visible === true);
      return { ok: true };
    },
  );

  // Plugin themes: the renderer needs the sanitized CSS itself, so this
  // channel returns the payload rather than only the catalog.
  //
  // Deliberately *not* scope-filtered. The selected theme is one global app
  // setting, so filtering here would make the whole window repaint when the
  // user opened a different folder, and strand them on a theme that no longer
  // resolves. Project scope governs what a plugin may *do* in a project, not
  // how the app looks.
  handle(IPC.invoke.pluginThemes, async () => plugins.getThemes());

  // Resident service supervision state; refreshed on the pluginChanged event.
  handle(IPC.invoke.pluginServices, async () => plugins.getServiceStates());

  handle(IPC.invoke.marketRefresh, async (payload?: { force?: boolean }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("market.refresh", { force: payload?.force ?? true });
  });

  handle(IPC.invoke.marketSearch, async (payload?: { query?: string; category?: string }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("market.search", {
      query: payload?.query ?? "",
      category: payload?.category ?? "",
    });
  });

  handle(IPC.invoke.marketGetDetail, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("market.getDetail", { id });
  });

  handle(IPC.invoke.marketInstall, async (payload: {
    id: string;
    version?: string;
    enable?: boolean;
    autoUpdate?: boolean;
    grantedPermissions?: string[];
  }) => {
    if (!host) throw new Error("host unavailable");
    const installed = await host.call<{ result: any }>("market.install", payload);
    const plugin = installed.result?.plugin;
    if (plugin?.enabled && plugin?.path) {
      await plugins.loadFromPath(plugin.path, plugin.permissions ?? []);
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{ reason: "market.install", pluginId: payload.id });
    return installed;
  });

  handle(
    IPC.invoke.marketCheckUpdates,
    async (payload?: { refreshRemote?: boolean }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("market.checkUpdates", {
        refreshRemote: payload?.refreshRemote ?? true,
      });
    },
  );

  handle(IPC.invoke.marketApplyUpdates, async (payload?: { onlyAuto?: boolean }) => {
    if (!host) throw new Error("host unavailable");
    const applied = await host.call<{ results: any[]; plugins: any[] }>("market.applyUpdates", {
      onlyAuto: payload?.onlyAuto ?? true,
    });
    for (const item of applied.results ?? []) {
      const plugin = item?.plugin;
      if (plugin?.enabled && plugin?.path) {
        await plugins.loadFromPath(plugin.path, plugin.permissions ?? []);
      }
    }
    sendToRenderer(IPC.event.pluginChanged,{ reason: "market.applyUpdates" });
    return applied;
  });

  handle(IPC.invoke.commandPaletteSearch, async (query: string) => {
    const q = (query || "").toLowerCase();
    const builtin = builtinPaletteItems();
    const root = await optionalWorkspaceRoot();
    const pluginCmds = plugins
      .getCommands()
      .filter((c) => pluginActiveInProject(c.pluginId, root))
      .map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        keywords: c.keywords,
        source: "plugin" as const,
        pluginId: c.pluginId,
      }));
    const extensionCmds = agentExtensions.allCommands().map((c) => ({
      id: trustedExtensionCommandId(c.name),
      title: `/${c.name}`,
      category: c.extensionLabel,
      keywords: c.description ? [c.description] : [],
      source: "extension" as const,
      extensionId: c.extensionId,
    }));
    return {
      commands: [...builtin, ...pluginCmds, ...extensionCmds].filter((c) => {
        if (!q) return true;
        const hay = `${c.title} ${c.category ?? ""} ${(c as any).keywords?.join(" ") ?? ""}`.toLowerCase();
        return hay.includes(q);
      }),
    };
  });

  handle(IPC.invoke.commandPaletteExecute, async (commandId: string) => {
    if (commandId.startsWith("builtin.")) {
      return { ok: true, commandId };
    }
    if (trustedExtensionCommandName(commandId) !== undefined) {
      // Extension commands need a session; the renderer routes them through
      // `extensions/commands/run` with the active session id.
      throw Object.assign(new Error("extension commands run inside a session"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const cmd = plugins.getCommands().find((c) => c.id === commandId);
    if (!cmd) throw new Error("command not found");
    // A command can be typed into the composer by name, so the scope has to be
    // re-checked here and not only where the lists are built.
    if (!pluginActiveInProject(cmd.pluginId, await optionalWorkspaceRoot())) {
      throw Object.assign(new Error("command not available in this project"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    await cmd.run();
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    return { ok: true, commandId };
  });

  handle(IPC.invoke.logOpenFolder, async () => {
    const logs = join(dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    await shell.openPath(stripWinLongPrefix(logs));
    return { ok: true, path: logs };
  });

  handle(IPC.invoke.devtoolsToggle, async (input: unknown) => {
    if (!developerMode) throw new Error("developer mode is disabled");
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("window unavailable");
    }
    const contents = mainWindow.webContents;
    const desired = (input as { open?: unknown } | null)?.open;
    const open =
      typeof desired === "boolean" ? desired : !contents.isDevToolsOpened();
    if (open) contents.openDevTools({ mode: "detach" });
    else contents.closeDevTools();
    return { open };
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
