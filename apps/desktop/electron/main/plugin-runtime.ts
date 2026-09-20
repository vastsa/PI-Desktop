import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  statSync,
  rmSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  busTopicAllowed,
  isDeniedFsPath,
  isFsPathInScope,
  isValidBusTopic,
  isValidBusTopicPattern,
  isNetUrlAllowed,
  isNetSocketUrlAllowed,
  matchesBusTopic,
  matchFsGlob,
  normalizeFsPath,
  parseNetDomains,
  parseSkillFrontmatter,
  pluginMcpToolKey,
  pluginSkillId,
  pluginThemeId,
  pluginToolName,
  resolveFsAccess,
  resolveMcpRefs,
  isExternalThemeAssetPath,
  normalizeThemeAssetPath,
  sanitizeThemeCss,
  skillIdFromPath,
  themeAssetUrl,
  formatPluginThemeVariables,
  normalizePluginThemeVariableValues,
  validatePluginThemeVariables,
  THEME_ASSET_MAX_BYTES,
  THEME_CSS_MAX_BYTES,
  WINDOW_BACKGROUND_COLOR_PATTERN,
  resolvePluginLocalizedString,
  validateManifest,
  validateMcpServer,
  type ClipboardHistoryEntry,
  type PluginCompleteInput,
  type PluginCompleteResult,
  type PluginFsMode,
  type PluginFsPolicy,
  type PluginFsRule,
  type PluginLlmContext,
  type PluginManifest,
  type PluginModelInfo,
  type PluginNativeNotificationInput,
  type PluginNativeNotificationResult,
  type PluginNotificationPermission,
  type PluginServiceContrib,
  type PluginSettingContrib,
  type PluginSkillContrib,
  type PluginThemeVariableContrib,
} from "@pi-desktop/plugin-sdk";
import {
  isAllowedKeybinding,
  isReservedKeybinding,
  normalizeKeybinding,
  type PluginServiceStatus,
  type PluginSettingDefinition,
  type PluginWorkspaceInfo,
  BUILTIN_SPEECH_PROTOCOL_IDS,
} from "@pi-desktop/shared";
import {
  previewFile,
  resolveRealPathForCreateWithinRoot,
  resolveRealPathWithinRoot,
  resolveWithinRoot,
} from "@pi-desktop/host-runtime";
import { desktopDataDir } from "./data-paths";
import { McpServerClient, type McpServerClientOptions } from "./plugin-mcp";
import { PluginToolInvocations, type PluginToolInvocation } from "./plugin-tool-invocations";
import { DevPluginWatcher, type DevPluginWatcherDeps } from "./plugin-watcher";
import { parseAllowedExternalUrl } from "./safe-open-external";
import type { PluginAppearance } from "../shared/plugin-panel-chrome";
import type { McpControlController, McpControlInvokeInput } from "./mcp-control";
import {
  PluginSocketError,
  type PluginSocketEvent,
  type PluginWebSocketRegistry,
} from "./plugin-websocket";
import {
  PluginShortcutError,
  type PluginShortcutEntry,
  type PluginShortcutRegistry,
} from "./plugin-shortcut-registry";
import { repairImportedExtensionWrapper } from "./imported-plugin-wrapper";

export type RegisteredCommand = {
  id: string;
  title: string;
  category?: string;
  keywords?: string[];
  pluginId: string;
  run: () => Promise<void>;
};

export type RegisteredPluginTool = {
  fullName: string;
  pluginId: string;
  name: string;
  description: string;
  risk?: string;
  schema?: unknown;
  /**
   * Action names that may run in Plan or Goal mode. Omitted or empty
   * means the tool is hidden from the model in those modes (ADR 0211).
   */
  planSafeActions?: readonly string[];
  execute: (
    args: unknown,
    ctx?: {
      sessionId?: string;
      /**
       * Runtime turn identity for this tool call. Matches the `turnId` the host
       * reports through `session:turnEnded`, so a plugin can scope resources
       * (overlays, caches, helper sessions) to one host turn.
       */
      turnId?: string;
      signal?: AbortSignal;
      mode?: "agent" | "plan" | "goal";
      modelKey?: string;
      thinkingLevel?: string;
    },
  ) => Promise<unknown>;
};

/**
 * A skill document a plugin taught the agent (spec 07 §3). Only the metadata
 * travels into the system prompt; the body is loaded on demand by the model.
 */
/**
 * One ExtensionAPI module a plugin contributes (spec 07-plugins/16). The
 * module runs inside the agent sidecar; this record only says where it is
 * and which plugin owns it.
 */
export type RegisteredAgentExtension = {
  /** Realpath of the module; stable identity for the sidecar and diagnostics. */
  id: string;
  pluginId: string;
  pluginName: string;
  /** Absolute module path inside the plugin directory. */
  entry: string;
  root: string;
};

export type RegisteredPluginSkill = {
  /** `<pluginId>/<skillId>` — what the model passes to the Skill tool. */
  id: string;
  pluginId: string;
  skillId: string;
  name: string;
  description: string;
  /** Absolute path to the skill document inside the plugin directory. */
  path: string;
  bytes: number;
};

/**
 * A theme a plugin contributed (spec 07 §3). The CSS is read and sanitized once
 * at load time; the renderer injects the stored text verbatim.
 */
export type RegisteredPluginTheme = {
  /** `plugin:<pluginId>:<themeId>` — the value stored in `AppSettings.theme`. */
  id: string;
  pluginId: string;
  themeId: string;
  label: string;
  /** Palette the overrides layer on; drives `data-theme` in the renderer. */
  base: "light" | "dark";
  css: string;
  /** Host-generated declarations from manifest-validated variable values. */
  variablesCss?: string;
  /**
   * Native window background while this theme is selected, per resolved
   * palette. Absent unless the plugin declared it and holds
   * `ui.window.appearance` (ADR 0248).
   */
  windowBackground?: { light?: string; dark?: string };
};

export type PluginPanelRequest = {
  pluginId: string;
  title: string;
  width: number;
  height: number;
  htmlPath: string;
  locale?: string;
  theme?: "light" | "dark";
  /**
   * `"panel"` (default) keeps the 46px host drag band and its capsule.
   * `"widget"` is the transparent floating placement: no band, no capsule, a
   * whole-window drag map, and a host context menu instead of the capsule.
   */
  shape?: "panel" | "widget";
  /** Floating widget placement only: keep the surface above other windows. */
  alwaysOnTop?: boolean;
  /** Overrides the per-shape default: panels are resizable, widgets are not. */
  resizable?: boolean;
  /** The plugin's egress allowlist; the panel session is confined to it. */
  netDomains?: readonly string[];
  /** Allows the isolated panel to request microphone audio, never camera access. */
  allowMicrophone?: boolean;
  /** Development panels show the host drag-band reminder in their chrome. */
  development?: boolean;
};

export type PluginPanelBridgeContext = {
  /** Absolute path recorded by the panel preload for a real drop gesture. */
  droppedPath?: string;
};

/** Transport to one plugin host process (ADR 0008). */
export type PluginProcessHandle = {
  postMessage: (message: unknown) => void;
  onMessage: (handler: (message: any) => void) => void;
  onExit: (handler: (code: number) => void) => void;
  onLog?: (handler: (level: string, message: string) => void) => void;
  kill: () => void;
};

export type PluginProcessSpawner = (options: {
  pluginId: string;
  entry: string;
  pluginPath: string;
}) => PluginProcessHandle | Promise<PluginProcessHandle>;

/** One file access the plugin asked for and the manifest does not cover. */
export type PluginFsConsentRequest = {
  pluginId: string;
  pluginName: string;
  mode: PluginFsMode;
  /** Root-relative path, as the user would recognize it. */
  path: string;
  /** Absolute path, for the dialog's detail line. */
  fullPath: string;
  /** Set when the plugin tripped the delete rate brake rather than the scope. */
  reason?: "scope" | "rate";
};

/**
 * `session` grants the containing directory for the rest of the run.
 * A delete is never offered anything more durable than that.
 */
export type PluginFsConsentAnswer = "once" | "session" | "deny";

/** One dangerous desktop operation a plugin asked the host to run. */
export type PluginDesktopConsentRequest = {
  pluginId: string;
  pluginName: string;
  /** Operation id from the shared controller catalog, e.g. `session/delete`. */
  operation: string;
  /** Catalog description of the operation, for the dialog. */
  description: string;
  /** Positional arguments as the plugin supplied them (secret-stripped later). */
  args: unknown[];
};

export type PluginHostServices = {
  getWorkspacePath: () => string | null;
  /**
   * The workspace plus the project group behind it, when the caller can supply
   * it. Additive: `workspace.get` falls back to `getWorkspacePath` alone.
   */
  getWorkspaceInfo?: () => PluginWorkspaceInfo | null;
  /**
   * The project the tool session behind this call belongs to, when the host
   * tracks one. Additive: an fs call falls back to `getWorkspacePath` -- the
   * visible workspace -- for a panel call or an unknown session.
   */
  getWorkspacePathForSession?: (sessionId: string) => string | null;
  /** The set of `contributes.agentExtensions` modules changed (load/unload). */
  agentExtensionsChanged?: () => void;
  getLocale?: () => string;
  getAppVersion?: () => string;
  /**
   * The appearance the host is currently showing (palette, language, active
   * plugin theme). Panels and plugin processes read it through `app.getAppearance`;
   * the host broadcasts `appearance:changed` to open panels, docked views, and
   * loaded plugin processes when it changes (ADR 0280). Workspace switches push
   * `workspace:changed` the same way.
   */
  getAppearance?: () => PluginAppearance;
  /**
   * Persist and apply `AppSettings.theme`. Used by `pi.app.setTheme` so a
   * plugin panel can switch the shell theme without opening Settings.
   */
  setThemePreference?: (theme: string) => Promise<void>;
  /**
   * Broadcast that this plugin's contributed themes changed (runtime upsert /
   * remove). Host should notify the renderer and refresh panel appearance.
   */
  onPluginThemesChanged?: (pluginId: string) => void;
  showToast: (message: string, level?: "info" | "warn" | "error") => void;
  notify: (input: { title: string; body?: string }) => void;
  getNotificationPermission: () => PluginNotificationPermission | Promise<PluginNotificationPermission>;
  requestNotificationPermission: () => Promise<PluginNotificationPermission>;
  showNativeNotification: (
    input: PluginNativeNotificationInput,
  ) => Promise<PluginNativeNotificationResult>;
  openExternal: (url: string) => Promise<void>;
  /** Open one already-authorized file with the OS-associated application. */
  openPath: (fullPath: string) => Promise<void>;
  /** Reveal one already-authorized file in the OS file manager. */
  revealPath?: (fullPath: string) => Promise<void>;
  readClipboard: () => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  readClipboardHistory: () => Promise<ClipboardHistoryEntry[]>;
  openPanel: (request: PluginPanelRequest) => Promise<void>;
  closePanel: (pluginId: string) => Promise<void>;
  fetch?: (input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }) => Promise<{ status: number; headers: Record<string, string>; bodyText: string }>;
  /** The reviewed desktop operation controller shared with MCP. */
  desktopControl?: McpControlController;
  /**
   * Blocking, native consent for a plugin-originated dangerous desktop
   * operation (session delete, permission-mode change, tool approval). The
   * controller's `confirm` flag is only the caller's acknowledgement; the
   * user decides here. Without this service every dangerous operation from a
   * plugin is refused, which is the safe default for a headless host.
   */
  confirmDesktopControl?: (request: PluginDesktopConsentRequest) => Promise<boolean>;
  audit?: (entry: Record<string, unknown>) => void;
  /**
   * Blocking, native consent for a file access the manifest did not declare.
   * Without it every out-of-scope access is refused, which is the safe default
   * for a headless host.
   */
  confirmFsAccess?: (request: PluginFsConsentRequest) => Promise<PluginFsConsentAnswer>;
  /**
   * Move a path to the OS trash. Deletion is the one file operation that is
   * recoverable if we route it here, so the host supplies the trash rather than
   * the runtime calling `rm` — no quarantine copy of the user's data anywhere.
   */
  trashItem?: (fullPath: string) => Promise<void>;
  /**
   * Native directory picker backing the `userSelected` root: unlimited reach,
   * zero standing power, because the user points at the directory themselves.
   */
  pickDirectory?: (request: {
    pluginId: string;
    pluginName: string;
  }) => Promise<string | null>;
  /**
   * Absolute paths refused under every root, scope and grant — the app's own
   * data directory above all, which holds provider keys and the session store.
   */
  protectedPaths?: () => readonly string[];
  /** Overrides the forked host-process entry; tests point this at the source file. */
  hostEntry?: string;
  /** Overrides how a plugin host process is created; defaults to Electron utilityProcess. */
  spawnProcess?: PluginProcessSpawner;
  /**
   * Real-time sockets. Like the shortcut registry this is host-owned, so the
   * egress allowlist, the bounds and the release path are all decided in the
   * runtime rather than by plugin code.
   */
  pluginSockets?: PluginWebSocketRegistry;
  /** Transport overrides for plugin-declared MCP servers; tests inject stubs. */
  mcp?: Pick<
    McpServerClientOptions,
    "spawnImpl" | "fetchImpl" | "connectTimeoutMs" | "callTimeoutMs" | "discoveryTimeoutMs"
  >;
  /**
   * System-wide accelerators for plugins. The registry owns the platform's
   * `globalShortcut`; the runtime only routes plugin calls into it, so plugin
   * code can never register or fire another plugin's shortcut.
   */
  pluginShortcuts?: PluginShortcutRegistry;
  /** Fired when a plugin host process dies on its own (crash, OOM, hard exit). */
  onPluginCrash?: (info: { pluginId: string; name: string; exitCode: number }) => void;
  /** Fired when a resident service changes supervision state. */
  onServiceChange?: (status: PluginServiceStatus) => void;
  /** Fired after a development plugin was reloaded from disk, or failed to. */
  onPluginReloaded?: (info: {
    pluginId: string;
    name: string;
    ok: boolean;
    message?: string;
  }) => void;
  /** Work-panel guest + CDP, gated by `browser.cdp` in the runtime. */
  browser?: {
    navigate: (
      input: { url?: string; path?: string },
      sessionId?: string,
    ) => Promise<unknown>;
    action: (action: "back" | "forward" | "reload" | "stop") => void;
    setBounds: (pluginId: string, hole: unknown) => unknown;
    setVisible: (pluginId: string, visible: boolean) => void;
    getState: () => unknown;
    openExternal: () => void;
    snapshot: () => Promise<unknown>;
    screenshot: (
      input?: { fullPage?: boolean },
      sessionId?: string,
    ) => Promise<unknown>;
    click: (uid: string) => Promise<void>;
    fill: (uid: string, text: string) => Promise<void>;
    evaluate: (expression: string) => Promise<unknown>;
    console: (limit?: number) => unknown;
    cdp: (method: string, params?: unknown) => Promise<unknown>;
  };
  onPluginUnload?: (pluginId: string) => void;
  listModels?: () => Promise<PluginModelInfo[]>;
  getSessionContext?: (sessionId: string, stripToolName?: string) => Promise<PluginLlmContext>;
  complete?: (input: PluginCompleteInput & {
    sessionId?: string;
    stripToolName?: string;
    signal?: AbortSignal;
  }) => Promise<PluginCompleteResult>;
  session?: {
    list: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    get: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    listMessages: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    import: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    importBatch: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    rename: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    delete: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  project?: {
    create: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  /** Read-only completed-turn facts served by host-core's usage domain. */
  usage?: {
    listTurns: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
};

/** Host APIs a plugin process may reach. Anything else does not exist (spec 04 §2). */
const HOST_API_ALLOWLIST = new Set([
  "app.getVersion",
  "app.getLocale",
  "app.getAppearance",
  "app.setTheme",
  "themes.upsert",
  "themes.remove",
  "themes.list",
  "themes.setVariables",
  "plugin.getSettings",
  "plugin.setSettings",
  "plugin.getDataPath",
  "ui.openPanel",
  "ui.closePanel",
  "ui.showToast",
  "ui.notify",
  "ui.getNotificationPermission",
  "ui.requestNotificationPermission",
  "ui.showNativeNotification",
  "desktop.listOperations",
  "desktop.invoke",
  "workspace.get",
  "fs.readText",
  "fs.stat",
  "fs.readRange",
  "fs.readPreview",
  "fs.openDefault",
  "fs.reveal",
  "fs.writeText",
  "fs.glob",
  "fs.list",
  "fs.remove",
  "fs.requestDirectory",
  "clipboard.readText",
  "clipboard.writeText",
  "clipboard.getHistory",
  "shell.openExternal",
  "net.fetch",
  "bus.publish",
  "bus.subscribe",
  "bus.unsubscribe",
  "browser.navigate",
  "browser.action",
  "browser.setBounds",
  "browser.setVisible",
  "browser.getState",
  "browser.openExternal",
  "browser.snapshot",
  "browser.screenshot",
  "browser.click",
  "browser.fill",
  "browser.evaluate",
  "browser.console",
  "net.websocket.connect",
  "net.websocket.send",
  "net.websocket.close",
  "audio.getInputDevices",
  "audio.openInput",
  "audio.closeInput",
  "audio.getCaptureState",
  "audio.onInputFrame",
  "audio.offInputFrame",
  "audio.openOutput",
  "audio.writeOutput",
  "audio.stopOutput",
  "audio.closeOutput",
  "browser.cdp",
  "models.list",
  "session.getLlmContext",
  "session.list",
  "session.get",
  "session.listMessages",
  "session.import",
  "session.importBatch",
  "session.rename",
  "session.delete",
  "usage.listTurns",
  "agent.complete",
  "keyboard.registerGlobalShortcut",
  "keyboard.unregisterGlobalShortcut",
  "keyboard.listGlobalShortcuts",
]);

/** Load must finish (module eval + onLoad) inside this budget. */
const PLUGIN_LOAD_TIMEOUT_MS = 15_000;
/** Lifecycle hooks time out per spec 05 §3. */
const PLUGIN_HOOK_TIMEOUT_MS = 5_000;
/**
 * The unload hook gets a shorter budget on quit than it does on an explicit
 * unload: the user has asked the app to close, and no plugin's cleanup is worth
 * holding that window open for the full hook timeout.
 */
const PLUGIN_SHUTDOWN_HOOK_TIMEOUT_MS = 1_500;
/** Ceiling for tearing every plugin down, however many are loaded. */
const PLUGIN_DISPOSE_ALL_TIMEOUT_MS = 3_000;
/** Command palette invocations are user-facing; fail fast. */
const PLUGIN_COMMAND_TIMEOUT_MS = 30_000;
/** Kept under host-core's 120s tool budget so the plugin-side error wins. */
const PLUGIN_TOOL_TIMEOUT_MS = 110_000;
/** Side completions sit under the plugin tool budget (ADR 0174). */
export const PLUGIN_COMPLETE_TIMEOUT_MS = 90_000;
/** Fixed panel operations are user-facing and must not hang the renderer. */
const PLUGIN_PANEL_TIMEOUT_MS = 30_000;
const PANEL_SKILL_CHANNELS = new Set([
  "skill.list",
  "skill.read",
  "skill.create",
  "skill.update",
  "skill.remove",
  "skill.setEnabled",
]);
/** A plugin may teach at most this many skills; the rest are ignored. */
const MAX_SKILLS_PER_PLUGIN = 32;
/** Redirect hops `pi.net.fetch` follows; each one is re-checked against egress. */
const NET_FETCH_MAX_REDIRECTS = 5;

/**
 * The delay a response advertises, verbatim — the value a plugin has to parse
 * itself. `retry-after-ms` wins over `retry-after`, the same precedence the
 * runtime's provider retry uses.
 */
function retryAfterHeader(headers: Record<string, string>): string | undefined {
  let seconds: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "retry-after-ms") return value;
    if (lower === "retry-after") seconds ??= value;
  }
  return seconds;
}

/**
 * The audit entry for one completed `pi.net.fetch`. The response itself is
 * passed to the plugin untouched, so the entry reports the upstream status
 * verbatim: a 4xx/5xx is a failed call (`ok: false`), and that failed call
 * records the delay it advertised instead of a bare `429`. The host never
 * retries the plugin's request — retry and backoff are the plugin's own policy
 * (`docs/spec/07-plugins/03-plugin-api.md` §7) — so this is observability, not
 * a behaviour change: no field beyond these, and never a header set or a body.
 */
function netFetchAuditEntry(
  pluginId: string,
  url: string,
  status: number,
  headers: Record<string, string>,
): Record<string, unknown> {
  const retryAfter = status < 400 ? undefined : retryAfterHeader(headers);
  return {
    pluginId,
    api: "net.fetch",
    ok: status < 400,
    ts: Date.now(),
    url,
    status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

/** Skill documents above this size are refused (prompt budget, not disk). */
const MAX_SKILL_BYTES = 128 * 1024;
/** Catalog lines stay short — the body carries the detail. */
const MAX_SKILL_DESCRIPTION_CHARS = 240;
/**
 * Theme ids accepted by `pi.themes.upsert` / `contributes.themes[].id`.
 * Namespaced form `plugin:<pluginId>:<themeId>` is built by `pluginThemeId`.
 */
const THEME_LOCAL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const THEME_VARIABLES_SETTINGS_KEY = "__pi_themeVariables";
/** A plugin may bring at most this many MCP servers. */
const MAX_MCP_SERVERS_PER_PLUGIN = 8;
/** A plugin may keep at most this many resident services alive. */
const MAX_SERVICES_PER_PLUGIN = 4;
/** A resident service starts inside the hook budget or is marked failed. */
const SERVICE_START_TIMEOUT_MS = PLUGIN_HOOK_TIMEOUT_MS;
/** Restart backoff: 1s, 2s, 4s … so a crash loop cannot busy-spin the app. */
const SERVICE_RESTART_BASE_MS = 1_000;
const SERVICE_RESTART_MAX_DELAY_MS = 30_000;
/** After this many failed restarts the plugin is left down for the user to fix. */
const MAX_SERVICE_RESTARTS = 5;
/** A host process that stays up this long is healthy; the backoff resets. */
const SERVICE_HEALTHY_MS = 60_000;
/** Bus payloads are messages, not file transfers. */
const MAX_BUS_PAYLOAD_BYTES = 64 * 1024;
/** A plugin may hold at most this many live subscriptions. */
const MAX_BUS_SUBSCRIPTIONS_PER_PLUGIN = 16;
/** Publish budget per plugin, so a hot loop cannot flood every other plugin. */
const MAX_BUS_PUBLISH_PER_WINDOW = 100;
const BUS_RATE_WINDOW_MS = 10_000;
/**
 * Delete budget per plugin per window. `recursive: false` does not bound the
 * blast radius on its own -- a glob followed by a loop of single-file removes
 * empties a workspace just as well as `rm -rf` does. Past the budget the user
 * is asked, which is what tells a cleanup routine apart from a wipe.
 */
export const MAX_DELETES_PER_WINDOW = 50;
const DELETE_RATE_WINDOW_MS = 60_000;
/** Side completions spend user quota; keep a tight rolling brake. */
export const MAX_COMPLETES_PER_WINDOW = 8;
const COMPLETE_RATE_WINDOW_MS = 60_000;
export const MAX_COMPLETE_SYSTEM_CHARS = 32 * 1024;
export const MAX_COMPLETE_MESSAGE_CHARS = 200_000;
/** Kept from the pre-scope implementation: a listing is not a search index. */
const MAX_GLOB_MATCHES = 500;
/** Entries returned for one directory. A tree is walked lazily, not dumped. */
const MAX_LIST_ENTRIES = 1000;
/** Maximum bytes one plugin range call may cross the broker with. */
const MAX_FS_READ_RANGE_BYTES = 8 * 1024 * 1024;
/** Directories `pi.fs.glob` never walks into; they are noise and are denied anyway. */
const GLOB_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);
/** Entries in one plugin's write ledger; oldest are dropped past this. */
const MAX_WRITE_LEDGER_ENTRIES = 2000;
/** Host-owned file inside the plugin's data dir; the plugin API cannot reach it. */
const WRITE_LEDGER_FILE = "fs-write-ledger.json";

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LoadedPlugin = {
  manifest: PluginManifest;
  path: string;
  development: boolean;
  permissions: Set<string>;
  /** Effective file scope, after legacy permission names are folded in. */
  fsPolicy: PluginFsPolicy;
  /** Legacy fs permission names this plugin still declares, for the UI notice. */
  legacyFs: string[];
  /** Directory the user picked for this plugin's `userSelected` root, if any. */
  userRoot?: string;
  /** Timestamps of recent deletes, backing the rate brake. */
  deletes: number[];
  /** Memory-only grants created by a real panel drop gesture. */
  dropGrants: Map<string, { fullPath: string; requestPath: string }>;
  child?: PluginProcessHandle;
  pending: Map<string, PendingCall>;
  nextCallId: number;
  disposing: boolean;
};

type PluginApiError = Error & { code?: string };

/** Crash-restart bookkeeping for one plugin's resident services. */
type RestartRecord = {
  attempts: number;
  /** Pending restart, so an explicit unload can cancel it. */
  timer?: ReturnType<typeof setTimeout>;
  /** Clears `attempts` once the process has stayed up long enough. */
  healthy?: ReturnType<typeof setTimeout>;
};

function apiError(code: string, message: string): PluginApiError {
  const err = new Error(message) as PluginApiError;
  err.code = code;
  return err;
}

/**
 * Error code one host API call answers with. Host services classify their own
 * failures as `errorCode` (agent-runtime, host-core) while this runtime's own
 * refusals carry `code`; the broker forwards whichever is present so a plugin
 * can branch on the same documented code the app uses instead of reading every
 * service failure as a generic one. Every other host boundary reads the same
 * precedence — `data.errorCode`, then `errorCode`, then `code`.
 */
function pluginCallErrorCode(error: unknown): string {
  const candidate = error as
    | { code?: string; errorCode?: string; data?: { errorCode?: string } }
    | null
    | undefined;
  return (
    candidate?.data?.errorCode ??
    candidate?.errorCode ??
    candidate?.code ??
    "PLUGIN_API_FAILED"
  );
}

function pluginActionEnum(schema: unknown): readonly string[] | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const action = (properties as Record<string, unknown>).action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const enumValue = (action as { enum?: unknown }).enum;
  if (!Array.isArray(enumValue)) return null;
  const values: string[] = [];
  for (const entry of enumValue) {
    if (typeof entry !== "string") return null;
    values.push(entry);
  }
  return values;
}

/**
 * Normalize and validate a plugin tools `planSafeActions` declaration
 * (ADR 0211). Every entry must be a string and, when the schema carries an
 * `action` enum, must be one of that enum. The validation here is the
 * final defense in depth: the runtime normally hides unsafe tools from the
 * model in Plan mode, but a stray call must still be rejected.
 */
function normalizePlanSafeActions(
  raw: unknown,
  schema: unknown,
  toolName: string,
): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw apiError(
      "INVALID_ARGUMENT",
      `plugin tool ${toolName} planSafeActions must be a string array`,
    );
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry) {
      throw apiError(
        "INVALID_ARGUMENT",
        `plugin tool ${toolName} planSafeActions entries must be non-empty strings`,
      );
    }
    if (cleaned.includes(entry)) continue;
    cleaned.push(entry);
  }
  const actionEnum = pluginActionEnum(schema);
  if (actionEnum) {
    const actionSet = new Set(actionEnum);
    for (const action of cleaned) {
      if (!actionSet.has(action)) {
        throw apiError(
          "INVALID_ARGUMENT",
          `plugin tool ${toolName} planSafeActions entry ${action} is not in the schema action enum`,
        );
      }
    }
  }
  return cleaned;
}

const PLUGIN_SESSION_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const PLUGIN_SESSION_MAX_CONTENT_BYTES = 512 * 1024;
const PLUGIN_SESSION_MAX_TOOL_VALUE_BYTES = 256 * 1024;
const PLUGIN_SESSION_MAX_JSON_DEPTH = 8;
const PLUGIN_SESSION_RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function pluginSessionJsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(pluginSessionJsonDepth));
  }
  if (value && typeof value === "object") {
    return 1 + Math.max(0, ...Object.values(value).map(pluginSessionJsonDepth));
  }
  return 1;
}

function pluginSessionJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validatePluginSessionPayload(input: unknown, kind: "import" | "batch" | "other"): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw apiError("INVALID_PARAMS", "session input must be an object");
  }
  if (pluginSessionJsonBytes(input) > PLUGIN_SESSION_MAX_PAYLOAD_BYTES) {
    throw apiError("LIMIT_EXCEEDED", "session payload exceeds 32 MiB");
  }
  if (pluginSessionJsonDepth(input) > PLUGIN_SESSION_MAX_JSON_DEPTH) {
    throw apiError("LIMIT_EXCEEDED", "session JSON depth exceeds 8");
  }
  if (kind === "other") return;
  const value = input as Record<string, unknown>;
  const entries = kind === "batch" ? value.sessions : [value];
  if (!Array.isArray(entries)) throw apiError("INVALID_PARAMS", "sessions must be an array");
  if (kind === "batch" && entries.length > 100) {
    throw apiError("LIMIT_EXCEEDED", "session batch exceeds 100 items");
  }
  if (kind === "import" && entries.length > 1) {
    throw apiError("INVALID_PARAMS", "session import accepts one item");
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw apiError("INVALID_PARAMS", "session item must be an object");
    }
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const externalId = typeof item.externalId === "string" ? item.externalId : "";
    if (!title || [...title].length > 200) throw apiError("LIMIT_EXCEEDED", "title is invalid");
    if (!externalId || [...externalId].length > 256) {
      throw apiError("LIMIT_EXCEEDED", "externalId is invalid");
    }
    const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
    const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : "";
    const createdMs = Date.parse(createdAt);
    const updatedMs = Date.parse(updatedAt);
    if (!PLUGIN_SESSION_RFC3339.test(createdAt) || Number.isNaN(createdMs)) {
      throw apiError("INVALID_PARAMS", "createdAt must be RFC3339");
    }
    if (!PLUGIN_SESSION_RFC3339.test(updatedAt) || Number.isNaN(updatedMs)) {
      throw apiError("INVALID_PARAMS", "updatedAt must be RFC3339");
    }
    if (createdMs > updatedMs) throw apiError("INVALID_PARAMS", "createdAt is after updatedAt");
    if (!Array.isArray(item.messages) || item.messages.length > 2000) {
      throw apiError("LIMIT_EXCEEDED", "messages must contain at most 2000 items");
    }
    let previous = Number.NEGATIVE_INFINITY;
    for (const message of item.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw apiError("INVALID_PARAMS", "message must be an object");
      }
      const row = message as Record<string, unknown>;
      if (!["user", "assistant", "tool"].includes(String(row.role))) {
        throw apiError("INVALID_PARAMS", "message role is invalid");
      }
      if (typeof row.content !== "string" || new TextEncoder().encode(row.content).byteLength > PLUGIN_SESSION_MAX_CONTENT_BYTES) {
        throw apiError("LIMIT_EXCEEDED", "message content exceeds 512 KiB");
      }
      const messageAt = typeof row.createdAt === "string" ? row.createdAt : "";
      const messageMs = Date.parse(messageAt);
      if (!PLUGIN_SESSION_RFC3339.test(messageAt) || Number.isNaN(messageMs) || messageMs < previous) {
        throw apiError("INVALID_PARAMS", "message timestamps must be monotonic RFC3339 values");
      }
      previous = messageMs;
      if (row.role === "tool") {
        if (!row.toolName || !row.toolCallId || !["success", "error"].includes(String(row.toolStatus))) {
          throw apiError("INVALID_PARAMS", "tool message fields are invalid");
        }
        for (const field of ["toolArgs", "toolResult"]) {
          if (row[field] !== undefined && pluginSessionJsonBytes(row[field]) > PLUGIN_SESSION_MAX_TOOL_VALUE_BYTES) {
            throw apiError("LIMIT_EXCEEDED", `${field} exceeds 256 KiB`);
          }
        }
      }
    }
  }
}

function normalizePluginSessionInput(
  input: unknown,
  kind: "import" | "batch" | "other",
): Record<string, unknown> {
  validatePluginSessionPayload(input, kind);
  return { ...(input as Record<string, unknown>) };
}

/**
 * Bounds for the read-only usage fact listing. The host RPC re-checks the
 * same windows, so a caller that skips this main-process side still cannot
 * widen the scan (spec 07-plugins/03 §usage).
 */
const PLUGIN_USAGE_MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const PLUGIN_USAGE_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Absent/null keeps the host default; anything else must be an integer. */
function pluginUsageProjectId(value: Record<string, unknown>): number | undefined {
  const raw = value.projectId;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw apiError("INVALID_PARAMS", "projectId must be an integer");
  }
  return raw;
}

/**
 * Mirrors the host-side validation for `usage.listTurns`: absent/null fields
 * stay absent (the host applies the 30-day default window and 200-row page),
 * and anything out of range is rejected here so a plugin sees a plain
 * INVALID_PARAMS instead of a host round-trip. Implied bounds (now / now-30d)
 * are used only to check order and the 365-day cap.
 */
function normalizePluginUsageListTurnsInput(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw apiError("INVALID_PARAMS", "usage input must be an object");
  }
  const value = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const intField = (key: string): number | undefined => {
    const raw = value[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw apiError("INVALID_PARAMS", `${key} must be a non-negative integer`);
    }
    normalized[key] = raw;
    return raw;
  };
  const fromMs = intField("fromMs");
  const toMs = intField("toMs");
  const resolvedTo = toMs ?? Date.now();
  const resolvedFrom = fromMs ?? resolvedTo - PLUGIN_USAGE_DEFAULT_WINDOW_MS;
  if (resolvedTo < resolvedFrom) {
    throw apiError("INVALID_PARAMS", "toMs must be >= fromMs");
  }
  if (resolvedTo - resolvedFrom > PLUGIN_USAGE_MAX_WINDOW_MS) {
    throw apiError("INVALID_PARAMS", "usage window must span at most 365 days");
  }
  if (value.sessionId !== undefined && value.sessionId !== null) {
    if (typeof value.sessionId !== "string" || !value.sessionId.trim()) {
      throw apiError("INVALID_PARAMS", "sessionId must be a non-empty string");
    }
    normalized.sessionId = value.sessionId;
  }
  const projectId = pluginUsageProjectId(value);
  if (projectId !== undefined) normalized.projectId = projectId;
  if (value.cursor !== undefined && value.cursor !== null) {
    if (typeof value.cursor !== "string") {
      throw apiError("INVALID_PARAMS", "cursor must be a string");
    }
    if (value.cursor) normalized.cursor = value.cursor;
  }
  if (value.limit !== undefined && value.limit !== null) {
    const limit = value.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw apiError("INVALID_PARAMS", "limit must be an integer between 1 and 500");
    }
    normalized.limit = limit;
  }
  return normalized;
}

/** Key for the per-service supervision map. */
function serviceStateKey(pluginId: string, serviceId: string): string {
  return `${pluginId}:${serviceId}`;
}

/** One live bus subscription; the handler itself lives in the plugin process. */
type BusSubscription = {
  id: string;
  pluginId: string;
  pattern: string;
};

/**
 * A runtime subscription is allowed when the manifest declared exactly that
 * pattern, or declared a wider one that covers it — narrowing `a.*` down to
 * `a.b` at runtime is fine, widening is not.
 */
function busSubscribeAllowed(declared: string[] | undefined, pattern: string): boolean {
  if (!declared?.length) return false;
  if (declared.includes(pattern)) return true;
  return isValidBusTopic(pattern) && busTopicAllowed(declared, pattern);
}

/**
 * Permissions and file scope a plugin directory currently declares, with legacy
 * fs names already folded in so a hot reload compares like with like. Throws on
 * a manifest that is missing or unparseable, which is what a reload wants:
 * nothing is granted against a manifest nobody can read.
 */
function readDeclaredAccess(pluginPath: string): {
  permissions: string[];
  fs: PluginFsPolicy;
} {
  const manifestPath = join(pluginPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("PLUGIN_INVALID: manifest.json missing");
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    permissions?: unknown;
    renderer?: unknown;
    fs?: unknown;
  };
  const declared = Array.isArray(raw.permissions)
    ? raw.permissions.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (typeof raw.renderer === "string" && raw.renderer) declared.push("ui.renderer");
  const access = resolveFsAccess({ permissions: declared, fs: raw.fs });
  return { permissions: access.permissions, fs: access.policy };
}

/**
 * Scope a reload adds beyond what was approved. Patterns are compared as
 * written: narrowing a scope is always fine, and a widened one has to go back
 * through review rather than being reasoned about, because deciding whether one
 * glob covers another is not something to guess at behind the gateway.
 */
export function widenedFsScope(ceiling: PluginFsPolicy, next: PluginFsPolicy): string[] {
  const added: string[] = [];
  for (const mode of ["read", "write", "delete"] as const) {
    const before = ceiling[mode];
    const after = next[mode];
    if (!after) continue;
    if (!before) {
      added.push(`fs.${mode}`);
      continue;
    }
    if (after.root !== before.root) added.push(`fs.${mode}.root=${after.root}`);
    if (after.own && !before.own) added.push(`fs.${mode}.own`);
    for (const pattern of after.scope) {
      if (!before.scope.includes(pattern)) added.push(`fs.${mode}.scope=${pattern}`);
    }
  }
  return added;
}

/**
 * Manifest and folded access a development plugin directory declares right now,
 * for the permission review that has to happen before it is loaded. The same
 * read a reload performs, plus the identity the review UI needs to name it
 * before its first load.
 */
export function readDevPluginDeclaration(pluginPath: string): {
  manifest: PluginManifest;
  permissions: string[];
  fs: PluginFsPolicy;
} {
  const manifestPath = join(pluginPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("PLUGIN_INVALID: manifest.json missing");
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const validated = validateManifest(raw);
  if (!validated.ok || !validated.manifest) {
    throw new Error(`PLUGIN_INVALID: ${validated.error}`);
  }
  const access = readDeclaredAccess(pluginPath);
  return { manifest: validated.manifest, permissions: access.permissions, fs: access.fs };
}

/**
 * `realpath` with the input as its own fallback, for a path that may not exist
 * yet. Containment is decided by the host-runtime workspace-files checks; this only exists so the
 * relative path we compare scopes against is expressed in the same terms.
 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Resolve a plugin-relative path, or null when it would leave the plugin
 * directory. Manifest validation already rejects `..`, so this is defense in
 * depth against symlinked or oddly-cased contributions.
 */
export function resolveInsidePlugin(pluginPath: string, relative: string): string | null {
  const root = resolve(pluginPath);
  const target = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target !== root && target.startsWith(prefix) ? target : null;
}

/**
 * Resolve one theme's declared assets to files inside the plugin package.
 *
 * The manifest validator already checked the shape; here each entry has to
 * exist, stay out of the dependency directory, and fit the declared total. A
 * theme that asks for more than the budget gets none of its assets, so a sheet
 * referencing one is refused instead of served from a half-honoured list.
 */
function resolveThemeAssets(
  pluginPath: string,
  declared: readonly string[],
): { files: Map<string, string>; dropped: number } {
  const files = new Map<string, string>();
  if (!declared.length) return { files, dropped: 0 };
  let total = 0;
  let dropped = 0;
  for (const asset of declared) {
    const normalized = normalizeThemeAssetPath(asset);
    if (!normalized || normalized.split("/").includes("node_modules")) {
      dropped += 1;
      continue;
    }
    const absolute = isExternalThemeAssetPath(normalized)
      ? normalized
      : resolveInsidePlugin(pluginPath, normalized);
    if (!absolute || !existsSync(absolute)) {
      dropped += 1;
      continue;
    }
    try {
      total += statSync(absolute).size;
    } catch {
      dropped += 1;
      continue;
    }
    files.set(normalized, absolute);
  }
  if (total > THEME_ASSET_MAX_BYTES) return { files: new Map(), dropped: declared.length };
  return { files, dropped };
}

/**
 * Read `contributes.windowAppearance`.
 *
 * Only the two palette slots the host honours survive; the shape is the
 * manifest validator's job, and anything that slips past it is dropped here
 * rather than handed to `setBackgroundColor`.
 */
function resolveWindowBackground(
  value: unknown,
): { light?: string; dark?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const backgroundColor = (value as { backgroundColor?: unknown }).backgroundColor;
  if (!backgroundColor || typeof backgroundColor !== "object") return undefined;
  const result: { light?: string; dark?: string } = {};
  for (const key of ["light", "dark"] as const) {
    const color = (backgroundColor as Record<string, unknown>)[key];
    if (typeof color === "string" && WINDOW_BACKGROUND_COLOR_PATTERN.test(color)) {
      result[key] = color;
    }
  }
  return result.light || result.dark ? result : undefined;
}

/**
 * Minimal environment for a plugin process: the host's own env may carry
 * provider keys and shell secrets, and plugins have no business seeing them.
 */
function pluginProcessEnv(pluginId: string): Record<string, string> {
  const env: Record<string, string> = {
    PI_PLUGIN_ID: pluginId,
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Default spawner: an Electron utilityProcess per plugin. */
const spawnUtilityProcess: PluginProcessSpawner = async ({ pluginId, entry }) => {
  const { utilityProcess } = await import("electron");
  const child = utilityProcess.fork(entry, [], {
    serviceName: `pi-plugin-${pluginId.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    stdio: "pipe",
    env: pluginProcessEnv(pluginId),
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    onLog: (handler) => {
      child.stdout?.on("data", (chunk: Buffer | string) => handler("info", String(chunk).trimEnd()));
      child.stderr?.on("data", (chunk: Buffer | string) => handler("error", String(chunk).trimEnd()));
    },
    kill: () => {
      child.kill();
    },
  };
};

const SPEECH_HTTP_PARSE = new Set([
  "bytes",
  "json-text",
  "json-path",
  "openai-transcription",
  "openai-chat-audio",
]);

function parseSpeechAdapterReply(value: unknown): {
  kind: "text" | "audio" | "http";
  text?: string;
  mimeType?: string;
  data?: string;
  call?: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw apiError("INVALID_ARGUMENT", "speech adapter reply is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) throw apiError("PROVIDER_ERROR", "speech adapter returned empty text");
    return { kind: "text", text };
  }
  if (record.kind === "audio") {
    const data = typeof record.data === "string" ? record.data.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" && record.mimeType.trim()
        ? record.mimeType.trim()
        : "application/octet-stream";
    if (!data) throw apiError("PROVIDER_ERROR", "speech adapter returned empty audio");
    return { kind: "audio", mimeType, data };
  }
  if (record.kind === "http") {
    const call = record.call;
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw apiError("INVALID_ARGUMENT", "speech adapter http call is invalid");
    }
    const spec = call as Record<string, unknown>;
    if (typeof spec.url !== "string" || !spec.url.trim()) {
      throw apiError("INVALID_ARGUMENT", "speech adapter http call is invalid");
    }
    if (typeof spec.parse !== "string" || !SPEECH_HTTP_PARSE.has(spec.parse)) {
      throw apiError("INVALID_ARGUMENT", "speech adapter http parse is invalid");
    }
    return { kind: "http", call: spec };
  }
  throw apiError("INVALID_ARGUMENT", "speech adapter reply kind is invalid");
}

export class PluginRuntime {
  private commands = new Map<string, RegisteredCommand>();
  private tools = new Map<string, RegisteredPluginTool>();
  private speechAdapters = new Map<string, {
    protocol: string;
    label: string;
    roles: Array<"transcribe" | "synthesize">;
    pluginId: string;
  }>();
  private skills = new Map<string, RegisteredPluginSkill>();
  private agentExtensions = new Map<string, RegisteredAgentExtension>();
  private themes = new Map<string, RegisteredPluginTheme>();
  /**
   * Declared theme assets, keyed by plugin id and then by the package-relative
   * path the sheet writes. The `plugin-asset:` handler answers only from here,
   * so a path nobody declared has no URL at all (ADR 0248).
   */
  private themeAssets = new Map<string, Map<string, string>>();
  private mcpClients = new Map<string, McpServerClient[]>();
  private serviceStates = new Map<string, PluginServiceStatus>();
  private restarts = new Map<string, RestartRecord>();
  private busSubscriptions = new Map<string, BusSubscription>();
  private busRate = new Map<string, { windowStart: number; count: number }>();
  private readonly toolInvocations = new PluginToolInvocations();
  private completeRate = new Map<string, { windowStart: number; count: number }>();
  /**
   * File accesses the user allowed for the rest of the run, keyed
   * `<mode>:<directory>`. In memory only: a session grant that outlived the
   * session would be a standing permission nobody reviewed.
   */
  private fsConsent = new Map<string, Set<string>>();
  /** Cached write ledgers, keyed by plugin id. */
  private writeLedgers = new Map<string, Record<string, number>>();
  private nextBusSubscription = 1;
  /** Plugins being reloaded by the supervisor; their backoff must survive. */
  private restarting = new Set<string>();
  private loaded = new Map<string, LoadedPlugin>();
  private toasts: Array<{ message: string; level?: string }> = [];
  private services: PluginHostServices;
  /**
   * Development plugins under watch, with the permission ceiling the user
   * approved when they picked the folder. Survives a failed reload so the fix
   * that follows a syntax error still gets picked up.
   */
  private devPlugins = new Map<
    string,
    { path: string; permissions: string[]; fs: PluginFsPolicy }
  >();
  /** Plugin ids inside `reloadDevPlugin`, whose watch must outlive the unload. */
  private reloading = new Set<string>();
  private watcher: DevPluginWatcher;

  constructor(
    services?: Partial<PluginHostServices>,
    watcherOptions?: Pick<DevPluginWatcherDeps, "watch" | "debounceMs" | "max">,
  ) {
    this.services = {
      getWorkspacePath: () => null,
      showToast: (message, level) => {
        this.toasts.push({ message, level });
      },
      notify: (input) => {
        this.toasts.push({ message: `${input.title}${input.body ? `: ${input.body}` : ""}` });
      },
      getNotificationPermission: () => "unsupported",
      requestNotificationPermission: async () => "unsupported",
      showNativeNotification: async () => ({
        shown: false,
        permission: "unsupported",
      }),
      openExternal: async () => {
        throw apiError("UNSUPPORTED", "openExternal service missing");
      },
      openPath: async () => {
        throw apiError("UNSUPPORTED", "openPath service missing");
      },
      readClipboard: async () => "",
      writeClipboard: async () => undefined,
      readClipboardHistory: async () => [],
      openPanel: async (request) => {
        this.toasts.push({ message: `Opened panel for ${request.pluginId}` });
      },
      closePanel: async () => undefined,
      ...services,
    };
    this.watcher = new DevPluginWatcher({
      ...watcherOptions,
      reload: (pluginId) => this.reloadDevPlugin(pluginId),
      onProblem: (pluginId, message) => {
        this.services.audit?.({
          pluginId,
          api: "plugin.watch.error",
          ok: false,
          message,
          ts: Date.now(),
        });
      },
    });
  }

  setServices(services: Partial<PluginHostServices>): void {
    this.services = { ...this.services, ...services };
  }

  getCommands(): RegisteredCommand[] {
    return [...this.commands.values()];
  }

  getTools(): RegisteredPluginTool[] {
    return [...this.tools.values()];
  }

  getSpeechAdapter(protocol: string) {
    return this.speechAdapters.get(protocol);
  }

  listSpeechAdapters() {
    return [...this.speechAdapters.values()].map((entry) => ({
      id: entry.protocol,
      label: entry.label,
      roles: [...entry.roles],
      source: "plugin" as const,
      pluginId: entry.pluginId,
    }));
  }

  async runSpeechAdapter(
    job: { binding: { protocol: string } } & Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
    const adapter = this.speechAdapters.get(String(job.binding.protocol));
    if (!adapter) {
      throw apiError("SPEECH_PROTOCOL_UNSUPPORTED", `unknown speech protocol: ${job.binding.protocol}`);
    }
    const loaded = this.loaded.get(adapter.pluginId);
    if (!loaded?.child || loaded.disposing) {
      throw apiError("NOT_FOUND", `plugin not loaded: ${adapter.pluginId}`);
    }
    const reply = await this.sendToChild(
      loaded,
      {
        t: "call",
        method: "speech.handle",
        payload: { protocol: adapter.protocol, ...payload, role: (job as { role?: string }).role },
      },
      60_000,
    );
    return parseSpeechAdapterReply(reply);
  }

  /** ExtensionAPI modules from loaded plugins holding `agent.extension`. */
  getAgentExtensions(): RegisteredAgentExtension[] {
    return [...this.agentExtensions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Catalog of active plugin skills, ordered by id for a stable prompt. */
  getSkills(): RegisteredPluginSkill[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Themes contributed by loaded plugins, ordered by id for a stable list. */
  getThemes(): RegisteredPluginTheme[] {
    return [...this.themes.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Absolute path of one declared theme asset, or null.
   *
   * The `plugin-asset:` handler calls this for every request, so a disabled
   * plugin, an undeclared path, and a path outside the package all answer null
   * for the same reason.
   */
  /**
   * Serve an absolute local file to a theme that referenced it by path.
   *
   * A runtime-registered theme has no manifest entry to declare assets in, so the
   * reference itself is the authorization: an absolute path on the extension
   * whitelist that exists on disk is added to this plugin's asset map for as long
   * as the plugin stays loaded (unloading a plugin clears the whole map).
   *
   * The upsert is a message, not a file write, so a theme can pick up a new image
   * without the plugin reloading.
   */
  private externalThemeAsset(loaded: LoadedPlugin, target: string): string | null {
    const key = normalizeThemeAssetPath(target);
    if (!key || !isExternalThemeAssetPath(key)) return null;
    let stats: Stats;
    try {
      stats = statSync(key);
    } catch {
      return null;
    }
    if (!stats.isFile() || stats.size > THEME_ASSET_MAX_BYTES) return null;
    let registry = this.themeAssets.get(loaded.manifest.id);
    if (!registry) {
      registry = new Map();
      this.themeAssets.set(loaded.manifest.id, registry);
    }
    registry.set(key, key);
    return themeAssetUrl(loaded.manifest.id, key);
  }

  resolveThemeAsset(pluginId: string, assetPath: string): string | null {
    const normalized = normalizeThemeAssetPath(assetPath);
    if (!normalized) return null;
    return this.themeAssets.get(pluginId)?.get(normalized) ?? null;
  }

  /** Supervision state of every resident service, ordered for a stable list. */
  getServiceStates(): PluginServiceStatus[] {
    return [...this.serviceStates.values()].sort(
      (a, b) =>
        a.pluginId.localeCompare(b.pluginId) || a.serviceId.localeCompare(b.serviceId),
    );
  }

  /**
   * Read one skill document on demand (the model asks for it by id through the
   * `Skill` tool). Front matter is stripped so the model sees instructions
   * only, and the size cap is re-checked because the file may have changed
   * since load.
   */
  loadSkillBody(id: string): { id: string; name: string; body: string } {
    const skill = this.skills.get(id);
    if (!skill) throw apiError("NOT_FOUND", `unknown skill: ${id}`);
    if (!this.loaded.has(skill.pluginId)) {
      throw apiError("NOT_FOUND", `plugin not loaded: ${skill.pluginId}`);
    }
    let raw: string;
    try {
      raw = readFileSync(skill.path, "utf8");
    } catch {
      throw apiError("NOT_FOUND", `skill document missing: ${id}`);
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BYTES) {
      throw apiError("INVALID_ARGUMENT", `skill document too large: ${id}`);
    }
    const parsed = parseSkillFrontmatter(raw);
    if (!parsed.body) {
      throw apiError("INVALID_ARGUMENT", `skill document is empty: ${id}`);
    }
    this.services.audit?.({
      pluginId: skill.pluginId,
      api: "plugin.skill.load",
      ok: true,
      skillId: skill.id,
      ts: Date.now(),
    });
    return { id: skill.id, name: skill.name, body: parsed.body };
  }

  getLoaded(pluginId: string): LoadedPlugin | undefined {
    return this.loaded.get(pluginId);
  }

  /**
   * Read a persisted declared variable without exposing the plugin's private
   * settings record. Host-rendered scenic destinations use this only after
   * validating the matching declaration themselves.
   */
  getThemeVariableValue(pluginId: string, themeId: string, name: string): unknown {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) return undefined;
    return this.readThemeVariableValues(loaded, themeId)[name];
  }

  async setScenicThemeBlur(pluginId: string, themeId: string, blur: number): Promise<void> {
    const loaded = this.loaded.get(pluginId);
    if (!loaded || !loaded.permissions.has("ui.theme")) {
      throw apiError("PERMISSION_DENIED", "ui.theme");
    }
    await this.hostApi(loaded).themes.setVariables(themeId, { "--nexus-backdrop-blur": blur });
  }

  /** Manifest settings as the installed-plugin sheet reads them. Titles stay the author's language; plugin-owned UI localizes via `app.getLocale` / `appearance:changed` (ADR 0280). */
  async getPluginSettings(pluginId: string): Promise<PluginSettingDefinition[]> {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) throw apiError("NOT_FOUND", `plugin not loaded: ${pluginId}`);
    const values = await this.hostApi(loaded).plugin.getSettings();
    return this.settingsView(loaded, values);
  }

  /** Validate and persist user settings, then notify the plugin process. */
  async setPluginSettings(
    pluginId: string,
    partial: Record<string, unknown>,
  ): Promise<PluginSettingDefinition[]> {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) throw apiError("NOT_FOUND", `plugin not loaded: ${pluginId}`);
    if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
      throw apiError("INVALID_ARGUMENT", "plugin settings must be an object");
    }
    const definitions = loaded.manifest.contributes?.settings ?? [];
    const definitionByKey = new Map(definitions.map((setting) => [setting.key, setting]));
    for (const [key, value] of Object.entries(partial)) {
      const definition = definitionByKey.get(key);
      if (!definition) throw apiError("INVALID_ARGUMENT", `unknown plugin setting: ${key}`);
      this.validateSettingValue(definition, value);
    }
    const current = await this.hostApi(loaded).plugin.getSettings();
    const next = { ...current, ...partial };
    await this.hostApi(loaded).plugin.setSettings(partial);
    loaded.child?.postMessage({
      t: "event",
      event: "plugin:settingsChanged",
      args: [next],
    });
    return this.settingsView(loaded, next);
  }

  private settingsView(
    loaded: LoadedPlugin,
    values: Record<string, unknown>,
  ): PluginSettingDefinition[] {
    return (loaded.manifest.contributes?.settings ?? []).map((setting) => ({
      key: setting.key,
      title: setting.title,
      ...(setting.description ? { description: setting.description } : {}),
      type: setting.type as PluginSettingDefinition["type"],
      ...(setting.default === undefined ? {} : { default: setting.default }),
      ...(setting.enum ? { enum: setting.enum } : {}),
      ...(setting.command ? { command: setting.command } : {}),
      scope: "plugin",
      value: values[setting.key] ?? setting.default,
    }));
  }

  private validateSettingValue(
    setting: PluginSettingContrib,
    value: unknown,
  ): void {
    switch (setting.type) {
      case "string":
        if (typeof value !== "string") throw apiError("INVALID_ARGUMENT", `setting ${setting.key} must be a string`);
        return;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw apiError("INVALID_ARGUMENT", `setting ${setting.key} must be a finite number`);
        }
        return;
      case "boolean":
        if (typeof value !== "boolean") throw apiError("INVALID_ARGUMENT", `setting ${setting.key} must be a boolean`);
        return;
      case "json":
        try {
          if (JSON.stringify(value) === undefined) {
            throw new Error("not JSON serializable");
          }
        } catch {
          throw apiError("INVALID_ARGUMENT", `setting ${setting.key} must be JSON serializable`);
        }
        return;
      case "select":
        if (!setting.enum?.some((option) => Object.is(option.value, value))) {
          throw apiError("INVALID_ARGUMENT", `setting ${setting.key} has an invalid option`);
        }
        return;
      case "shortcut": {
        if (typeof value !== "string") {
          throw apiError("INVALID_ARGUMENT", `setting ${setting.key} must be a shortcut`);
        }
        const normalized = normalizeKeybinding(value);
        const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
        if (!normalized || !isAllowedKeybinding(normalized) || isReservedKeybinding(normalized, platform)) {
          throw apiError("INVALID_ARGUMENT", `setting ${setting.key} has an invalid shortcut`);
        }
        return;
      }
      default:
        throw apiError("INVALID_ARGUMENT", `setting ${setting.key} has an unsupported type`);
    }
  }

  listLoaded(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  drainToasts(): string[] {
    const t = this.toasts.map((x) => x.message);
    this.toasts = [];
    return t;
  }

  /**
   * Push a one-way host event to every loaded plugin process. Panel pages
   * receive the same names through `pluginBridge.on`; this is the process
   * half (spec 07 §5).
   */
  broadcastEvent(event: string, args: unknown[] = []): void {
    for (const loaded of this.loaded.values()) {
      try {
        loaded.child?.postMessage({ t: "event", event, args });
      } catch (error) {
        // One unreachable recipient must not starve the rest of the fan-out. The
        // event is one-way: whoever is live still receives it.
        this.services.audit?.({
          pluginId: loaded.manifest.id,
          api: "plugin.event.error",
          ok: false,
          event,
          message: (error as Error).message,
          ts: Date.now(),
        });
      }
    }
  }

  /**
   * Validate the manifest, start a dedicated host process and run `onLoad`
   * inside it. Contribution points arrive over RPC while `onLoad` runs; a
   * failure anywhere rolls the whole load back (spec 05 §7).
   */
  async loadFromPath(
    pluginPath: string,
    grantedPermissions?: string[],
    options: { development?: boolean } = {},
  ): Promise<PluginManifest> {
    const manifestPath = join(pluginPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("PLUGIN_INVALID: manifest.json missing");
    }
    // Generated no-op `main.js` wrappers fail under package `"type":"module"`.
    repairImportedExtensionWrapper(pluginPath);
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const validated = validateManifest(raw);
    if (!validated.ok || !validated.manifest) {
      throw new Error(`PLUGIN_INVALID: ${validated.error}`);
    }
    const manifest = validated.manifest;
    await this.unload(manifest.id);

    const mainPath = resolveInsidePlugin(pluginPath, manifest.main);
    if (!mainPath) {
      throw new Error("PLUGIN_INVALID: main entry must stay inside the plugin directory");
    }
    if (!existsSync(mainPath)) {
      throw new Error("PLUGIN_LOAD_FAILED: main entry missing");
    }

    // Legacy `fs.*.workspace` names resolve to the scoped form, so an install
    // recorded before scopes existed keeps working -- with the reduced reach
    // `resolveFsAccess` assigns it, not the whole workspace it used to get.
    const access = resolveFsAccess(manifest);
    const declared = new Set(access.permissions);
    // A grant list is the user's answer and it is final: re-adding everything
    // the manifest declares would quietly undo `plugins.revokePermissions` on
    // the next load. Only a load with no recorded answer falls back to the
    // declaration.
    const granted =
      grantedPermissions === undefined
        ? declared
        : new Set(
            resolveFsAccess({ permissions: grantedPermissions }).permissions.filter(
              (perm) => declared.has(perm),
            ),
          );

    const entry = this.services.hostEntry ?? join(__dirname, "plugin-host-process.js");
    const spawn = this.services.spawnProcess ?? spawnUtilityProcess;
    const child = await spawn({ pluginId: manifest.id, entry, pluginPath });

    const loaded: LoadedPlugin = {
      manifest,
      path: pluginPath,
      development: options.development ?? this.devPlugins.has(manifest.id),
      permissions: granted,
      fsPolicy: access.policy,
      legacyFs: access.legacy,
      deletes: [],
      dropGrants: new Map(),
      child,
      pending: new Map(),
      nextCallId: 1,
      disposing: false,
    };
    this.loaded.set(manifest.id, loaded);

    child.onMessage((message) => this.handleChildMessage(loaded, message));
    child.onExit((code) => this.handleChildExit(loaded, code));
    child.onLog?.((level, message) => {
      if (!message) return;
      this.services.audit?.({
        pluginId: manifest.id,
        api: "plugin.stdio",
        level,
        message,
        ts: Date.now(),
      });
    });

    try {
      await this.sendToChild(
        loaded,
        {
          t: "init",
          pluginId: manifest.id,
          pluginPath,
          main: manifest.main,
          manifest,
        },
        PLUGIN_LOAD_TIMEOUT_MS,
      );
    } catch (error) {
      await this.unload(manifest.id);
      this.services.audit?.({
        pluginId: manifest.id,
        api: "plugin.load.error",
        ok: false,
        errorCode: (error as PluginApiError).code ?? "PLUGIN_LOAD_FAILED",
        ts: Date.now(),
      });
      throw error;
    }

    this.registerSkills(loaded);
    this.registerAgentExtensions(loaded);
    this.registerThemes(loaded);
    await this.registerMcpServers(loaded);
    await this.startServices(loaded);
    // After the child's `onLoad`, so the plugin's commands already exist: a
    // declared shortcut whose command was never registered is reported and
    // skipped rather than held against a command that cannot run.
    this.registerDeclaredShortcuts(loaded);
    this.services.audit?.({
      pluginId: manifest.id,
      api: "plugin.load.success",
      ok: true,
      ts: Date.now(),
    });
    return manifest;
  }

  /** Abort this session's invocations without affecting sibling sessions. */
  cancelSessionTools(sessionId: string, reason = "Session tool execution aborted"): void {
    this.toolInvocations.cancelSession(sessionId, reason);
  }

  /** Deregister contributions, run `onUnload` in the child, then stop it. */
  async unload(pluginId: string): Promise<void> {
    const loaded = this.loaded.get(pluginId);
    if (loaded) {
      loaded.disposing = true;
      this.toolInvocations.cancelOwner(loaded, "Plugin unloaded");
      // An explicit stop ends supervision; a supervisor-driven reload keeps it.
      if (!this.restarting.has(pluginId)) this.cancelRestarts(pluginId);
      await this.stopServices(loaded);
    }
    if (loaded?.child) {
      loaded.disposing = true;
      try {
        await this.sendToChild(
          loaded,
          { t: "call", method: "lifecycle.unload", payload: {} },
          PLUGIN_HOOK_TIMEOUT_MS,
        );
      } catch {
        // A stuck or already-dead child must never block teardown.
      }
      this.rejectPending(loaded, apiError("PLUGIN_UNLOADED", `plugin unloaded: ${pluginId}`));
      try {
        loaded.child.kill();
      } catch {
        // Already gone.
      }
    }
    this.clearContributions(pluginId);
    this.loaded.delete(pluginId);
    // A reload unloads before it loads; its watch has to outlive that, and so
    // does the permission ceiling it reloads against.
    if (!this.reloading.has(pluginId)) {
      this.watcher.remove(pluginId);
      this.devPlugins.delete(pluginId);
    }
    await this.services.closePanel(pluginId);
    this.services.onPluginUnload?.(pluginId);
    if (loaded) {
      this.services.audit?.({ pluginId, api: "plugin.unload", ok: true, ts: Date.now() });
    }
  }

  /**
   * Watch a loaded development plugin so source edits reload it in place.
   *
   * The permission set recorded here is the ceiling for every later reload:
   * grants were approved against the manifest as it looked when the user chose
   * the folder, and no file edit may widen them.
   */
  watchDevPlugin(pluginId: string): void {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) return;
    this.devPlugins.set(pluginId, {
      path: loaded.path,
      permissions: [...loaded.permissions],
      fs: loaded.fsPolicy,
    });
    this.watcher.add(pluginId, loaded.path);
  }

  isWatchingDevPlugin(pluginId: string): boolean {
    return this.watcher.isWatching(pluginId);
  }

  /**
   * The approval a development plugin is loaded under: the permission set and
   * the file scope the user accepted when they last reviewed it, or null when
   * the plugin is not watched. Both the hot reload and the manual reload measure
   * a manifest edit against this record, never against the manifest itself —
   * the manifest is the request, this is the answer.
   */
  devApproval(pluginId: string): { permissions: string[]; fs: PluginFsPolicy } | null {
    const dev = this.devPlugins.get(pluginId);
    return dev ? { permissions: [...dev.permissions], fs: dev.fs } : null;
  }

  /** Stop every watch; called on app quit alongside the other subsystems. */
  disposeWatchers(): void {
    this.watcher.disposeAll();
    this.devPlugins.clear();
  }

  /**
   * Tear every plugin host down for app quit.
   *
   * Quitting kills the children either way; what this adds is that they go down
   * *as a shutdown*. `disposing` is set before anything else so the exits that
   * follow are not read as crashes — otherwise every quit ends in an error log,
   * an "unexpectedly stopped" toast, and a supervisor scheduling restarts into a
   * closing app.
   *
   * Plugins stop in parallel and the whole sequence is bounded: a wedged
   * `onUnload` must never be the reason the app appears to hang on quit.
   */
  async disposeAll(): Promise<void> {
    const loadedPlugins = [...this.loaded.values()];
    // Mark first, in one pass: a child that dies while a sibling is still
    // stopping must already be covered by the guard in `handleChildExit`.
    for (const loaded of loadedPlugins) {
      loaded.disposing = true;
      this.toolInvocations.cancelOwner(loaded, "Application shutting down");
      this.cancelRestarts(loaded.manifest.id);
    }
    this.disposeWatchers();
    await Promise.race([
      Promise.allSettled(loadedPlugins.map((loaded) => this.disposePlugin(loaded))),
      new Promise((resolve) => setTimeout(resolve, PLUGIN_DISPOSE_ALL_TIMEOUT_MS).unref?.()),
    ]);
    // Whatever survived the budget is killed outright; the app is going away.
    for (const loaded of loadedPlugins) {
      try {
        loaded.child?.kill();
      } catch {
        // Already gone.
      }
    }
    this.loaded.clear();
    this.serviceStates.clear();
  }

  /** Stop one plugin's services and run its unload hook, for `disposeAll`. */
  private async disposePlugin(loaded: LoadedPlugin): Promise<void> {
    const pluginId = loaded.manifest.id;
    await this.stopServices(loaded);
    if (!loaded.child) return;
    try {
      await this.sendToChild(
        loaded,
        { t: "call", method: "lifecycle.unload", payload: {} },
        PLUGIN_SHUTDOWN_HOOK_TIMEOUT_MS,
      );
    } catch {
      // A stuck or already-dead child must never block quit.
    }
    this.rejectPending(loaded, apiError("PLUGIN_UNLOADED", `plugin unloaded: ${pluginId}`));
    this.clearContributions(pluginId);
  }

  /**
   * Re-run a watched development plugin from disk.
   *
   * A manifest that now declares permissions outside the recorded ceiling stops
   * here: hot reload must never widen a permission set behind the gateway. The
   * plugin stays watched either way, so the edit that fixes a broken reload is
   * picked up like any other.
   */
  async reloadDevPlugin(pluginId: string): Promise<void> {
    const dev = this.devPlugins.get(pluginId);
    if (!dev) return;
    const name = this.loaded.get(pluginId)?.manifest.name ?? pluginId;
    this.reloading.add(pluginId);
    try {
      const declaredAccess = readDeclaredAccess(dev.path);
      const declared = declaredAccess.permissions;
      const ceiling = new Set(dev.permissions);
      const added = declared.filter((permission) => !ceiling.has(permission));
      const widened = widenedFsScope(dev.fs, declaredAccess.fs);
      if (added.length || widened.length) {
        throw new Error(
          `PERMISSION_DENIED: manifest now requests ${[...added, ...widened].join(", ")}; reload it from the Plugins page to review`,
        );
      }
      // Grants follow the manifest downwards, never upwards: a permission the
      // author removed stops being available on the next reload.
      const manifest = await this.loadFromPath(dev.path, declared, { development: true });
      this.devPlugins.set(pluginId, {
        path: dev.path,
        permissions: dev.permissions,
        fs: dev.fs,
      });
      this.services.audit?.({
        pluginId,
        api: "plugin.reload.success",
        ok: true,
        ts: Date.now(),
      });
      this.services.onPluginReloaded?.({ pluginId, name: manifest.name, ok: true });
    } catch (error) {
      const message = (error as Error).message;
      this.services.audit?.({
        pluginId,
        api: "plugin.reload.error",
        ok: false,
        message,
        ts: Date.now(),
      });
      this.services.onPluginReloaded?.({ pluginId, name, ok: false, message });
    } finally {
      this.reloading.delete(pluginId);
    }
  }

  async invokePanelBridge(
    pluginId: string,
    channel: string,
    payload?: Record<string, unknown>,
    context?: PluginPanelBridgeContext,
  ): Promise<unknown> {
    return this.toolInvocations.withoutContext(() => this.invokePanelWithoutToolContext(pluginId, channel, payload, context));
  }

  private async invokePanelWithoutToolContext(
    pluginId: string,
    channel: string,
    payload?: Record<string, unknown>,
    context?: PluginPanelBridgeContext,
  ): Promise<unknown> {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) throw apiError("NOT_FOUND", `plugin not loaded: ${pluginId}`);
    if (PANEL_SKILL_CHANNELS.has(channel)) {
      return this.sendToChild(
        loaded,
        {
          t: "call",
          method: "panel.invoke",
          payload: { channel, payload: payload ?? {} },
        },
        PLUGIN_PANEL_TIMEOUT_MS,
      );
    }
    const api = this.hostApi(loaded);
    switch (channel) {
      case "ui.showToast":
        await api.ui.showToast(String(payload?.message ?? ""), payload?.level as any);
        return { ok: true };
      case "ui.notify":
        await api.ui.notify({
          title: String(payload?.title ?? "Plugin"),
          body: payload?.body ? String(payload.body) : undefined,
        });
        return { ok: true };
      case "ui.getNotificationPermission":
        return api.ui.getNotificationPermission();
      case "ui.requestNotificationPermission":
        return api.ui.requestNotificationPermission();
      case "ui.showNativeNotification":
        return api.ui.showNativeNotification({
          title: String(payload?.title ?? "Plugin"),
          body: payload?.body ? String(payload.body) : undefined,
        });
      case "ui.closePanel":
        await api.ui.closePanel();
        return { ok: true };
      case "fs.readText":
        return api.fs.readText(String(payload?.path ?? ""));
      case "fs.stat":
        return api.fs.stat(
          String(payload?.path ?? ""),
          typeof payload?.grantId === "string" ? payload.grantId : undefined,
        );
      case "fs.readRange":
        return api.fs.readRange(
          String(payload?.path ?? ""),
          Number(payload?.byteOffset),
          Number(payload?.length),
          typeof payload?.grantId === "string" ? payload.grantId : undefined,
        );
      case "fs.registerDropped":
        return this.registerDroppedFile(
          loaded,
          String(payload?.path ?? ""),
          context?.droppedPath,
        );
      case "fs.readPreview":
        return api.fs.readPreview(String(payload?.path ?? ""));
      case "fs.openDefault":
        await api.fs.openDefault(String(payload?.path ?? ""));
        return { ok: true };
      case "fs.reveal":
        await api.fs.reveal(String(payload?.path ?? ""));
        return { ok: true };
      case "fs.writeText":
        await api.fs.writeText(String(payload?.path ?? ""), String(payload?.content ?? ""));
        return { ok: true };
      case "fs.glob":
        return api.fs.glob(String(payload?.pattern ?? "*"));
      case "fs.list":
        return api.fs.list(String(payload?.path ?? ""));
      // Deleting is not reachable from a panel; choosing a directory is, and
      // has to be, because a "pick a folder" button is panel UI by nature.
      case "fs.requestDirectory":
        return api.fs.requestDirectory();
      case "clipboard.readText":
        return api.clipboard.readText();
      case "clipboard.writeText":
        await api.clipboard.writeText(String(payload?.text ?? ""));
        return { ok: true };
      case "clipboard.getHistory":
        return api.clipboard.getHistory();
      case "shell.openExternal":
        await api.shell.openExternal(String(payload?.url ?? ""));
        return { ok: true };
      case "net.fetch":
        return api.net.fetch({
          url: String(payload?.url ?? ""),
          method: payload?.method ? String(payload.method) : undefined,
          headers: (payload?.headers as Record<string, string> | undefined) ?? undefined,
          body: payload?.body ? String(payload.body) : undefined,
          timeoutMs: typeof payload?.timeoutMs === "number" ? payload.timeoutMs : undefined,
        });
      case "plugin.getSettings":
        return api.plugin.getSettings();
      case "app.getAppearance":
        return api.app.getAppearance();
      case "app.setTheme":
        await api.app.setTheme(String(payload?.themeId ?? ""));
        return { ok: true };
      case "themes.upsert":
        await api.themes.upsert({
          id: String(payload?.id ?? ""),
          label: String(payload?.label ?? ""),
          base: payload?.base === "light" ? "light" : "dark",
          css: String(payload?.css ?? ""),
        });
        return { ok: true };
      case "themes.remove":
        await api.themes.remove(String(payload?.themeId ?? payload?.id ?? ""));
        return { ok: true };
      case "themes.list":
        return api.themes.list();
      case "themes.setVariables":
        await api.themes.setVariables(
          String(payload?.themeId ?? ""),
          (payload?.values as Record<string, number | string> | undefined) ?? {},
        );
        return { ok: true };
      case "workspace.get":
        return api.workspace.get();
      case "models.list":
        this.assertPermission(loaded, "models.list");
        return this.dispatchHostCall(loaded, "models.list", []);
      case "browser.navigate":
        return this.invokeBrowser(loaded, "navigate", payload);
      case "browser.action":
        return this.invokeBrowser(loaded, "action", payload);
      case "browser.setBounds":
        return this.invokeBrowser(loaded, "setBounds", payload);
      case "browser.setVisible":
        return this.invokeBrowser(loaded, "setVisible", payload);
      case "browser.getState":
        return this.invokeBrowser(loaded, "getState", payload);
      case "browser.openExternal":
        return this.invokeBrowser(loaded, "openExternal", payload);
      case "browser.snapshot":
        return this.invokeBrowser(loaded, "snapshot", payload);
      case "browser.screenshot":
        return this.invokeBrowser(loaded, "screenshot", payload);
      case "browser.click":
        return this.invokeBrowser(loaded, "click", payload);
      case "browser.fill":
        return this.invokeBrowser(loaded, "fill", payload);
      case "browser.evaluate":
        return this.invokeBrowser(loaded, "evaluate", payload);
      case "browser.console":
        return this.invokeBrowser(loaded, "console", payload);
      case "browser.cdp":
        return this.invokeBrowser(loaded, "cdp", payload);
      default:
        // The panel is the plugin's own UI: any channel the host does not
        // implement itself is forwarded to the plugin's onPanelInvoke so
        // plugins can define their own panel↔main-process channels
        // (e.g. the domain manager's "domain.sync" data bridge).
        return this.sendToChild(
          loaded,
          {
            t: "call",
            method: "panel.invoke",
            payload: { channel, payload: payload ?? {} },
          },
          PLUGIN_PANEL_TIMEOUT_MS,
        );
    }
  }

  // --- plugin host process plumbing -------------------------------------

  private sendToChild(
    loaded: LoadedPlugin,
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = loaded.child;
    if (!child) {
      return Promise.reject(apiError("NOT_FOUND", `plugin host process gone: ${loaded.manifest.id}`));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = `h${loaded.nextCallId++}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const cancelChild = (error: Error) => {
        if (typeof message.invocationId !== "string") return;
        try {
          child.postMessage({ t: "cancel", invocationId: message.invocationId, reason: error.message });
        } catch {
          // The process may already be gone; the host still revokes the call.
        }
      };
      const abort = () => {
        const error = signal?.reason instanceof Error
          ? signal.reason
          : apiError("PLUGIN_TOOL_ABORTED", "Plugin tool execution aborted");
        loaded.pending.get(id)?.reject(error);
        cancelChild(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        loaded.pending.delete(id);
        signal?.removeEventListener("abort", abort);
      };
      const timer = setTimeout(() => {
        const error = apiError("TIMEOUT", `plugin ${loaded.manifest.id} did not answer ${String(message.t)}`);
        loaded.pending.get(id)?.reject(error);
        cancelChild(error);
      }, timeoutMs);
      loaded.pending.set(id, {
        resolve: (value) => { cleanup(); resolvePromise(value); },
        reject: (error) => { cleanup(); rejectPromise(error); },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        child.postMessage({ ...message, id });
      } catch (error) {
        loaded.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleChildMessage(loaded: LoadedPlugin, message: any): void {
    if (!message || typeof message !== "object") return;
    if (message.t === "res") {
      const entry = loaded.pending.get(message.id);
      if (!entry) return;
      loaded.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(apiError(message.error?.code ?? "UNKNOWN", message.error?.message ?? "plugin call failed"));
      return;
    }
    if (message.t === "log") {
      this.services.audit?.({
        pluginId: loaded.manifest.id,
        api: "plugin.log",
        level: message.level,
        message: String(message.message ?? ""),
        ts: Date.now(),
      });
      return;
    }
    if (message.t === "call") {
      void this.toolInvocations.run(loaded, message.invocationId, async () => {
        if (this.loaded.get(loaded.manifest.id) !== loaded) {
          throw apiError("PLUGIN_UNLOADED", "Plugin host process is no longer active");
        }
        return this.dispatchHostCall(loaded, String(message.api ?? ""), message.args ?? []);
      })
        .then((value) =>
          loaded.child?.postMessage({ t: "res", id: message.id, ok: true, value: value ?? null }),
        )
        .catch((error: PluginApiError) =>
          loaded.child?.postMessage({
            t: "res",
            id: message.id,
            ok: false,
            error: {
              code: pluginCallErrorCode(error),
              message: error?.message ?? String(error),
            },
          }),
        );
    }
  }

  /**
   * The broker: every plugin API call crosses here, so the permission gateway
   * and the allowlist run in the host, never in plugin-controlled code.
   */
  private async dispatchHostCall(
    loaded: LoadedPlugin,
    api: string,
    args: unknown[],
  ): Promise<unknown> {
    const pluginId = loaded.manifest.id;
    switch (api) {
      case "commands.register": {
        const descriptor = (args[0] ?? {}) as {
          id?: string;
          title?: string;
          keywords?: string[];
          category?: string;
        };
        const id = String(descriptor.id ?? "");
        if (!id) throw apiError("INVALID_ARGUMENT", "command.id is required");
        this.commands.set(id, {
          id,
          title: String(descriptor.title ?? id),
          category: descriptor.category,
          keywords: descriptor.keywords,
          pluginId,
          run: async () => {
            const target = this.loaded.get(pluginId);
            if (!target?.child) throw apiError("NOT_FOUND", `plugin not loaded: ${pluginId}`);
            await this.sendToChild(
              target,
              { t: "call", method: "command.run", payload: { id } },
              PLUGIN_COMMAND_TIMEOUT_MS,
            );
          },
        });
        return { ok: true };
      }
      case "commands.unregister": {
        this.commands.delete(String(args[0] ?? ""));
        return { ok: true };
      }
      case "keyboard.registerGlobalShortcut": {
        this.assertPermission(loaded, "keyboard.globalShortcut");
        const descriptor = (args[0] ?? {}) as {
          id?: string;
          accelerator?: string;
          command?: string;
        };
        return this.registerShortcut(loaded, {
          id: String(descriptor.id ?? ""),
          accelerator: String(descriptor.accelerator ?? ""),
          command: String(descriptor.command ?? ""),
        });
      }
      case "keyboard.unregisterGlobalShortcut": {
        this.assertPermission(loaded, "keyboard.globalShortcut");
        const registry = this.services.pluginShortcuts;
        if (!registry) {
          throw apiError("UNSUPPORTED", "global shortcuts are unavailable in this host");
        }
        const id = String(args[0] ?? "");
        if (!id) throw apiError("INVALID_ARGUMENT", "shortcut.id is required");
        const removed = registry.unregister(pluginId, id);
        this.services.audit?.({
          pluginId,
          api: "keyboard.globalShortcut.unregister",
          ok: removed,
          ...(removed ? {} : { errorCode: "NOT_FOUND" }),
          ts: Date.now(),
        });
        return { ok: removed };
      }
      case "keyboard.listGlobalShortcuts": {
        this.assertPermission(loaded, "keyboard.globalShortcut");
        const registry = this.services.pluginShortcuts;
        if (!registry) return [];
        return registry.list(pluginId).map((entry) => ({
          id: entry.id,
          accelerator: entry.accelerator,
          command: entry.command,
          registered: true,
        }));
      }
      case "net.websocket.connect": {
        this.assertPermission(loaded, "net.websocket");
        const descriptor = (args[0] ?? {}) as {
          url?: string;
          headers?: Record<string, string>;
          protocols?: string[];
          timeoutMs?: number;
        };
        const url = String(descriptor.url ?? "");
        const registry = this.services.pluginSockets;
        if (!registry) {
          throw apiError("UNSUPPORTED", "real-time connections are unavailable in this host");
        }
        // Same allowlist, same chokepoint: a socket to an undeclared host is
        // refused before the transport is asked to open anything.
        this.assertSocketEgress(loaded, url);
        try {
          const result = await registry.connect({
            pluginId,
            url,
            headers: descriptor.headers,
            protocols: descriptor.protocols,
            timeoutMs:
              typeof descriptor.timeoutMs === "number" ? descriptor.timeoutMs : undefined,
          });
          this.services.audit?.({
            pluginId,
            api: "net.websocket.connect",
            ok: true,
            ts: Date.now(),
            url,
            socketId: result.socketId,
          });
          return result;
        } catch (error) {
          const code =
            error instanceof PluginSocketError ? error.code : "CONNECT_FAILED";
          this.services.audit?.({
            pluginId,
            api: "net.websocket.connect",
            ok: false,
            errorCode: code,
            ts: Date.now(),
            url,
          });
          throw apiError(code, (error as Error).message);
        }
      }
      case "net.websocket.send": {
        this.assertPermission(loaded, "net.websocket");
        const registry = this.services.pluginSockets;
        if (!registry) {
          throw apiError("UNSUPPORTED", "real-time connections are unavailable in this host");
        }
        const descriptor = (args[0] ?? {}) as {
          socketId?: string;
          data?: string | Uint8Array;
        };
        try {
          registry.send({
            pluginId,
            socketId: String(descriptor.socketId ?? ""),
            data: descriptor.data ?? "",
          });
          return { ok: true };
        } catch (error) {
          // Sends are frequent enough that auditing every one would drown the
          // log; only refusals are recorded, and they name no payload.
          if (error instanceof PluginSocketError) {
            this.services.audit?.({
              pluginId,
              api: "net.websocket.send",
              ok: false,
              errorCode: error.code,
              ts: Date.now(),
            });
            throw apiError(error.code, error.message);
          }
          throw error;
        }
      }
      case "net.websocket.close": {
        this.assertPermission(loaded, "net.websocket");
        const registry = this.services.pluginSockets;
        if (!registry) {
          throw apiError("UNSUPPORTED", "real-time connections are unavailable in this host");
        }
        const descriptor = (args[0] ?? {}) as {
          socketId?: string;
          code?: number;
          reason?: string;
        };
        try {
          registry.close({
            pluginId,
            socketId: String(descriptor.socketId ?? ""),
            code: typeof descriptor.code === "number" ? descriptor.code : undefined,
            reason: typeof descriptor.reason === "string" ? descriptor.reason : undefined,
          });
          this.services.audit?.({
            pluginId,
            api: "net.websocket.close",
            ok: true,
            ts: Date.now(),
            socketId: descriptor.socketId,
          });
          return { ok: true };
        } catch (error) {
          const code = error instanceof PluginSocketError ? error.code : "NOT_FOUND";
          this.services.audit?.({
            pluginId,
            api: "net.websocket.close",
            ok: false,
            errorCode: code,
            ts: Date.now(),
          });
          throw apiError(code, (error as Error).message);
        }
      }
      case "agent.registerTool": {
        this.assertPermission(loaded, "agent.tool.register");
        const descriptor = (args[0] ?? {}) as {
          name?: string;
          description?: string;
          risk?: string;
          schema?: unknown;
          planSafeActions?: unknown;
        };
        const name = String(descriptor.name ?? "");
        if (!name) throw apiError("INVALID_ARGUMENT", "tool.name is required");
        const fullName = pluginToolName(pluginId, name);
        const planSafeActions = normalizePlanSafeActions(
          descriptor.planSafeActions,
          descriptor.schema,
          name,
        );
        this.tools.set(fullName, {
          fullName,
          pluginId,
          name,
          description: String(descriptor.description ?? ""),
          risk: descriptor.risk,
          schema: descriptor.schema,
          planSafeActions,
          execute: async (toolArgs, ctx) => {
            // Plan/Goal mode only allows declared plan-safe actions. The
            // runtime normally hides unsafe tools from the model, but the
            // host must still reject a stray call (ADR 0211).
            if (ctx?.mode === "plan" || ctx?.mode === "goal") {
              const allowed = planSafeActions;
              if (allowed.length === 0) {
                throw apiError(
                  "PERMISSION_DENIED",
                  `plugin tool ${name} is not available in ${ctx.mode} mode`,
                );
              }
              const action =
                toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
                  ? (toolArgs as { action?: unknown }).action
                  : undefined;
              if (typeof action !== "string" || !allowed.includes(action)) {
                throw apiError(
                  "PERMISSION_DENIED",
                  `plugin tool ${name} action ${JSON.stringify(action)} is not allowed in ${ctx.mode} mode`,
                );
              }
            }
            const target = this.loaded.get(pluginId);
            if (!target?.child || target !== loaded || target.disposing) {
              throw apiError("NOT_FOUND", `plugin not loaded: ${pluginId}`);
            }
            const sessionId = String(ctx?.sessionId ?? "");
            const invocation = this.toolInvocations.begin(target, {
              pluginId,
              sessionId,
              toolName: name,
              turnId: ctx?.turnId,
              signal: ctx?.signal,
            });
            try {
              return await this.sendToChild(
                  target,
                  {
                    t: "call",
                    method: "tool.execute",
                    invocationId: invocation.id,
                    payload: {
                      name,
                      args: toolArgs,
                      sessionId,
                      turnId: ctx?.turnId,
                      mode: ctx?.mode,
                      modelKey: ctx?.modelKey,
                      thinkingLevel: ctx?.thinkingLevel,
                    },
                  },
                  PLUGIN_TOOL_TIMEOUT_MS,
                  invocation.signal,
              );
            } catch (error) {
              this.toolInvocations.cancel(invocation, error);
              throw error;
            } finally {
              this.toolInvocations.finish(invocation);
            }
          },
        });
        return { ok: true };
      }
      case "agent.unregisterTool": {
        this.tools.delete(pluginToolName(pluginId, String(args[0] ?? "")));
        return { ok: true };
      }
      case "speech.registerAdapter": {
        this.assertPermission(loaded, "speech.adapter.register");
        const descriptor = (args[0] ?? {}) as {
          protocol?: string;
          label?: string;
          roles?: unknown;
        };
        const protocol = String(descriptor.protocol ?? "").trim();
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(protocol)) {
          throw apiError("INVALID_ARGUMENT", "speech protocol is invalid");
        }
        if ((BUILTIN_SPEECH_PROTOCOL_IDS as readonly string[]).includes(protocol)) {
          throw apiError("CONFLICT", "speech protocol is reserved");
        }
        const existing = this.speechAdapters.get(protocol);
        if (existing && existing.pluginId !== pluginId) {
          throw apiError("CONFLICT", `speech protocol in use: ${protocol}`);
        }
        const roles = Array.isArray(descriptor.roles)
          ? descriptor.roles.filter((role): role is "transcribe" | "synthesize" =>
              role === "transcribe" || role === "synthesize",
            )
          : [];
        if (roles.length === 0) throw apiError("INVALID_ARGUMENT", "speech roles are required");
        this.speechAdapters.set(protocol, {
          protocol,
          label: String(descriptor.label ?? protocol),
          roles: [...new Set(roles)],
          pluginId,
        });
        this.services.audit?.({
          pluginId,
          api: "speech.registerAdapter",
          ok: true,
          ts: Date.now(),
          protocol,
        });
        return { ok: true };
      }
      case "speech.unregisterAdapter": {
        const protocol = String(args[0] ?? "").trim();
        const existing = this.speechAdapters.get(protocol);
        if (existing?.pluginId === pluginId) this.speechAdapters.delete(protocol);
        return { ok: true };
      }
      case "models.list": {
        this.assertPermission(loaded, "models.list");
        const models = (await this.services.listModels?.()) ?? [];
        this.services.audit?.({
          pluginId,
          api: "models.list",
          ok: true,
          count: models.length,
          ts: Date.now(),
        });
        return models;
      }
      case "session.getLlmContext": {
        return this.readSessionContext(loaded);
      }
      case "session.import": {
        this.assertPermission(loaded, "session.import");
        const input = normalizePluginSessionInput(args[0] ?? {}, "import");
        if (input.projectId !== undefined && input.projectId !== null) {
          this.assertPermission(loaded, "project.create");
        }
        const source = this.sessionSource(loaded, input.source);
        input.sourceLabel = source.label;
        if (!this.services.session?.import) {
          throw apiError("UNSUPPORTED", "host api not available: session.import");
        }
        return this.services.session.import(loaded.manifest.id, input);
      }
      case "session.importBatch": {
        this.assertPermission(loaded, "session.import");
        const input = normalizePluginSessionInput(args[0] ?? {}, "batch");
        const items = Array.isArray(input.sessions) ? input.sessions : [];
        if (items.some((item) => item && typeof item === "object" &&
          (item as Record<string, unknown>).projectId !== undefined &&
          (item as Record<string, unknown>).projectId !== null)) {
          this.assertPermission(loaded, "project.create");
        }
        const source = this.sessionSource(loaded, input.source);
        input.sourceLabel = source.label;
        if (!this.services.session?.importBatch) {
          throw apiError("UNSUPPORTED", "host api not available: session.importBatch");
        }
        return this.services.session.importBatch(loaded.manifest.id, input);
      }
      case "project.create": {
        this.assertPermission(loaded, "project.create");
        const input = args[0];
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw apiError("INVALID_PARAMS", "project input must be an object");
        }
        const path = (input as Record<string, unknown>).path;
        if (typeof path !== "string" || !path.trim() || [...path].length > 4096) {
          throw apiError("INVALID_PARAMS", "project path must be a non-empty string");
        }
        if (!this.services.project?.create) {
          throw apiError("UNSUPPORTED", "host api not available: project.create");
        }
        return this.services.project.create(loaded.manifest.id, { path: path.trim() });
      }
      case "session.list": {
        this.assertPermission(loaded, "session.read.own");
        const input = normalizePluginSessionInput(args[0] ?? {}, "other");
        if (input.source !== undefined) this.sessionSource(loaded, input.source);
        if (!this.services.session?.list) {
          throw apiError("UNSUPPORTED", "host api not available: session.list");
        }
        return this.services.session.list(loaded.manifest.id, input);
      }
      case "session.get": {
        this.assertPermission(loaded, "session.read.own");
        const input = normalizePluginSessionInput(args[0] ?? {}, "other");
        if (!this.services.session?.get) {
          throw apiError("UNSUPPORTED", "host api not available: session.get");
        }
        return this.services.session.get(loaded.manifest.id, input);
      }
      case "session.listMessages": {
        this.assertPermission(loaded, "session.read.own");
        const input = normalizePluginSessionInput(args[0] ?? {}, "other");
        if (!this.services.session?.listMessages) {
          throw apiError("UNSUPPORTED", "host api not available: session.listMessages");
        }
        return this.services.session.listMessages(loaded.manifest.id, input);
      }
      case "session.rename": {
        this.assertPermission(loaded, "session.update.own");
        const input = normalizePluginSessionInput(args[0] ?? {}, "other");
        if (!this.services.session?.rename) {
          throw apiError("UNSUPPORTED", "host api not available: session.rename");
        }
        return this.services.session.rename(loaded.manifest.id, input);
      }
      case "session.delete": {
        this.assertPermission(loaded, "session.delete.own");
        const input = normalizePluginSessionInput(args[0] ?? {}, "other");
        if (!this.services.session?.delete) {
          throw apiError("UNSUPPORTED", "host api not available: session.delete");
        }
        return this.services.session.delete(loaded.manifest.id, input);
      }
      case "usage.listTurns": {
        // Read-only completed-turn facts (spec 07-plugins/03 §usage): flat
        // counters and identifiers, no message body, no write path. Every
        // dashboard shape stays the plugin's own computation.
        this.assertPermission(loaded, "usage.read");
        const input = normalizePluginUsageListTurnsInput(args[0]);
        if (!this.services.usage?.listTurns) {
          throw apiError("UNSUPPORTED", "host api not available: usage.listTurns");
        }
        return this.services.usage.listTurns(loaded.manifest.id, input);
      }
      case "agent.complete": {
        return this.runAgentComplete(loaded, (args[0] ?? {}) as PluginCompleteInput);
      }
      default: {
        if (!HOST_API_ALLOWLIST.has(api)) {
          this.services.audit?.({
            pluginId,
            api,
            ok: false,
            errorCode: "UNSUPPORTED",
            ts: Date.now(),
          });
          throw apiError("UNSUPPORTED", `host api not available: ${api}`);
        }
        const [group, member] = api.split(".");
        const target = (this.hostApi(loaded) as any)[group]?.[member];
        if (typeof target !== "function") {
          throw apiError("UNSUPPORTED", `host api not available: ${api}`);
        }
        return target(...args);
      }
    }
  }

  private handleChildExit(loaded: LoadedPlugin, code: number): void {
    this.toolInvocations.cancelOwner(loaded, "Plugin host process exited");
    if (loaded.disposing) return;
    if (this.loaded.get(loaded.manifest.id) !== loaded) return;
    const pluginId = loaded.manifest.id;
    this.rejectPending(loaded, apiError("PLUGIN_CRASHED", `plugin host process exited: ${pluginId}`));
    this.clearContributions(pluginId);
    this.loaded.delete(pluginId);
    void this.services.closePanel(pluginId);
    this.services.audit?.({
      pluginId,
      api: "plugin.crash",
      ok: false,
      errorCode: "PLUGIN_CRASHED",
      exitCode: code,
      ts: Date.now(),
    });
    this.services.showToast(`Plugin stopped unexpectedly: ${loaded.manifest.name}`, "error");
    this.services.onPluginCrash?.({ pluginId, name: loaded.manifest.name, exitCode: code });
    this.superviseCrash(loaded);
  }

  /**
   * A crashed host process takes its resident services down with it. Restart it
   * with exponential backoff, and after `MAX_SERVICE_RESTARTS` leave the plugin
   * down rather than spin forever — the failed state is what the user sees.
   */
  private superviseCrash(loaded: LoadedPlugin): void {
    const pluginId = loaded.manifest.id;
    const declared = this.declaredServices(loaded);
    if (!declared.length) return;
    const record = this.restarts.get(pluginId) ?? { attempts: 0 };
    if (record.healthy) clearTimeout(record.healthy);
    record.healthy = undefined;
    this.markServices(loaded, "failed", record.attempts, "plugin host process exited");

    const restartable =
      loaded.permissions.has("background.service") &&
      declared.some((service) => service.autoRestart !== false);
    if (!restartable) return;

    record.attempts += 1;
    this.restarts.set(pluginId, record);
    if (record.attempts > MAX_SERVICE_RESTARTS) {
      this.markServices(loaded, "failed", record.attempts - 1, "restart limit reached");
      this.services.audit?.({
        pluginId,
        api: "plugin.service.restart",
        ok: false,
        errorCode: "LIMIT_EXCEEDED",
        attempts: record.attempts - 1,
        ts: Date.now(),
      });
      return;
    }
    const delayMs = Math.min(
      SERVICE_RESTART_BASE_MS * 2 ** (record.attempts - 1),
      SERVICE_RESTART_MAX_DELAY_MS,
    );
    this.services.audit?.({
      pluginId,
      api: "plugin.service.restart.scheduled",
      ok: true,
      attempt: record.attempts,
      delayMs,
      ts: Date.now(),
    });
    record.timer = setTimeout(() => {
      record.timer = undefined;
      void this.restartAfterCrash(loaded, record.attempts);
    }, delayMs);
  }

  private async restartAfterCrash(loaded: LoadedPlugin, attempt: number): Promise<void> {
    const pluginId = loaded.manifest.id;
    // The user may have re-enabled or removed the plugin while we waited.
    if (this.loaded.has(pluginId) || !existsSync(loaded.path)) return;
    this.restarting.add(pluginId);
    try {
      await this.loadFromPath(loaded.path, [...loaded.permissions]);
      this.services.audit?.({
        pluginId,
        api: "plugin.service.restart",
        ok: true,
        attempt,
        ts: Date.now(),
      });
    } catch (error) {
      this.markServices(loaded, "failed", attempt, (error as Error).message);
      this.services.audit?.({
        pluginId,
        api: "plugin.service.restart",
        ok: false,
        attempt,
        errorCode: (error as PluginApiError).code ?? "PLUGIN_LOAD_FAILED",
        message: (error as Error).message,
        ts: Date.now(),
      });
    } finally {
      this.restarting.delete(pluginId);
    }
  }

  private rejectPending(loaded: LoadedPlugin, error: Error): void {
    for (const entry of loaded.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    loaded.pending.clear();
  }

  /**
   * Index `contributes.globalShortcuts` after load. The declarative path only
   * takes accelerators whose command the plugin has actually registered in
   * this session: a shortcut that cannot reach its own command would be dead
   * weight in the registry, and refusing it keeps `listGlobalShortcuts` from
   * reporting a binding that does nothing. A refusal never fails the load.
   */
  private registerDeclaredShortcuts(loaded: LoadedPlugin): void {
    const registry = this.services.pluginShortcuts;
    const declared = loaded.manifest.contributes?.globalShortcuts ?? [];
    if (!registry || declared.length === 0) return;
    const pluginId = loaded.manifest.id;
    if (!loaded.permissions.has("keyboard.globalShortcut")) {
      this.services.audit?.({
        pluginId,
        api: "keyboard.globalShortcut.register",
        ok: false,
        errorCode: "PERMISSION_DENIED",
        ts: Date.now(),
      });
      return;
    }
    for (const entry of declared) {
      if (!entry.default) continue;
      if (this.commands.get(entry.command)?.pluginId !== pluginId) {
        this.services.audit?.({
          pluginId,
          api: "keyboard.globalShortcut.register",
          ok: false,
          errorCode: "NOT_FOUND",
          ts: Date.now(),
          command: entry.command,
        });
        continue;
      }
      this.registerShortcut(loaded, {
        id: entry.id,
        accelerator: entry.default,
        command: entry.command,
      });
    }
  }

  /**
   * The one registration path for both the declarative contribution and
   * `pi.keyboard.registerGlobalShortcut`. The registry decides conflicts; this
   * method adds the ownership check, the audit entry, and the result shape.
   */
  private registerShortcut(
    loaded: LoadedPlugin,
    request: { id: string; accelerator: string; command: string },
  ): {
    id: string;
    accelerator: string;
    command: string;
    registered: boolean;
    error?: string;
  } {
    const pluginId = loaded.manifest.id;
    const registry = this.services.pluginShortcuts;
    if (!registry) {
      throw apiError("UNSUPPORTED", "global shortcuts are unavailable in this host");
    }
    if (!request.id) throw apiError("INVALID_ARGUMENT", "shortcut.id is required");
    if (!request.accelerator) {
      throw apiError("INVALID_ARGUMENT", "shortcut.accelerator is required");
    }
    if (!request.command) {
      throw apiError("INVALID_ARGUMENT", "shortcut.command is required");
    }
    // A shortcut is not a way around command ownership: only the plugin's own
    // commands are reachable, exactly as in the command palette.
    if (this.commands.get(request.command)?.pluginId !== pluginId) {
      throw apiError(
        "INVALID_ARGUMENT",
        `shortcut command is not registered by this plugin: ${request.command}`,
      );
    }
    try {
      const entry = registry.register({
        pluginId,
        id: request.id,
        accelerator: request.accelerator,
        command: request.command,
      });
      this.services.audit?.({
        pluginId,
        api: "keyboard.globalShortcut.register",
        ok: true,
        ts: Date.now(),
        accelerator: entry.accelerator,
        command: entry.command,
      });
      return {
        id: entry.id,
        accelerator: entry.accelerator,
        command: entry.command,
        registered: true,
      };
    } catch (error) {
      // A refused registration is an answer, not an exception: the plugin gets
      // the code so it can fall back to another accelerator.
      const code =
        error instanceof PluginShortcutError ? error.code : "SHORTCUT_UNAVAILABLE";
      this.services.audit?.({
        pluginId,
        api: "keyboard.globalShortcut.register",
        ok: false,
        errorCode: code,
        ts: Date.now(),
        accelerator: request.accelerator,
        command: request.command,
      });
      return {
        id: request.id,
        accelerator: request.accelerator,
        command: request.command,
        registered: false,
        error: code,
      };
    }
  }

  /**
   * Host-called when the operating system reports a registered accelerator.
   * Only the owner's own command is reachable, and a failure is audited: a
   * system-wide key that silently does nothing is worse than a logged error.
   */
  async triggerPluginShortcut(entry: PluginShortcutEntry): Promise<void> {
    const command = this.commands.get(entry.command);
    if (!command || command.pluginId !== entry.pluginId) {
      this.services.audit?.({
        pluginId: entry.pluginId,
        api: "keyboard.globalShortcut.trigger",
        ok: false,
        errorCode: "NOT_FOUND",
        ts: Date.now(),
        command: entry.command,
      });
      return;
    }
    try {
      await command.run();
    } catch (error) {
      this.services.audit?.({
        pluginId: entry.pluginId,
        api: "keyboard.globalShortcut.trigger",
        ok: false,
        errorCode: (error as PluginApiError).code ?? "PLUGIN_ERROR",
        ts: Date.now(),
        command: entry.command,
      });
    }
  }

  private clearContributions(pluginId: string): void {
    for (const [id, cmd] of this.commands) {
      if (cmd.pluginId === pluginId) this.commands.delete(id);
    }
    for (const [name, tool] of this.tools) {
      if (tool.pluginId === pluginId) this.tools.delete(name);
    }
    for (const [protocol, adapter] of this.speechAdapters) {
      if (adapter.pluginId === pluginId) this.speechAdapters.delete(protocol);
    }
    for (const [id, skill] of this.skills) {
      if (skill.pluginId === pluginId) this.skills.delete(id);
    }
    let droppedExtension = false;
    for (const [id, extension] of this.agentExtensions) {
      if (extension.pluginId === pluginId) {
        this.agentExtensions.delete(id);
        droppedExtension = true;
      }
    }
    if (droppedExtension) this.services.agentExtensionsChanged?.();
    for (const [id, theme] of this.themes) {
      if (theme.pluginId === pluginId) this.themes.delete(id);
    }
    // A gone plugin must stop serving its assets; the handler resolves through
    // this map only, so clearing it revokes every `plugin-asset:` URL at once.
    this.themeAssets.delete(pluginId);
    // Closing the client kills the stdio child / drops the HTTP session, so a
    // disabled plugin leaves no process behind.
    for (const client of this.mcpClients.get(pluginId) ?? []) {
      try {
        client.close();
      } catch {
        // Teardown is best effort; a wedged transport must not block unload.
      }
    }
    this.mcpClients.delete(pluginId);
    // A gone plugin cannot receive: drop its routes so publishers stop paying
    // the fan-out cost, and reset its publish window.
    for (const [id, subscription] of this.busSubscriptions) {
      if (subscription.pluginId === pluginId) this.busSubscriptions.delete(id);
    }
    this.busRate.delete(pluginId);
    // A system-wide accelerator outlives every renderer, so it is released on
    // the same path that clears commands — disable, unload, and crash alike.
    this.services.pluginShortcuts?.releasePlugin(pluginId);
    // Same for a real-time connection: the host owns the socket, so a plugin
    // that is gone keeps neither the connection nor the frames still arriving.
    this.services.pluginSockets?.releasePlugin(pluginId);
  }

  /**
   * Index `contributes.skills` after the plugin loaded. Skills are declarative
   * (no code runs), so the manifest is the whole source of truth; the child
   * process is not consulted.
   *
   * Skills predate the permission gate, so a plugin that declares them without
   * `agent.prompt.inject` still loads — it just teaches the agent nothing.
   */
  /**
   * Index `contributes.agentExtensions`. The modules are loaded by the agent
   * sidecar at the next turn, so this only validates paths and records
   * ownership. Without `agent.extension` the plugin loads but contributes no
   * module, mirroring how skills behave without `agent.prompt.inject`.
   */
  private registerAgentExtensions(loaded: LoadedPlugin): void {
    const declared = loaded.manifest.contributes?.agentExtensions ?? [];
    if (!declared.length) return;
    const pluginId = loaded.manifest.id;
    if (!loaded.permissions.has("agent.extension")) {
      this.services.audit?.({
        pluginId,
        api: "plugin.agentExtensions.skipped",
        ok: false,
        errorCode: "PERMISSION_DENIED",
        count: declared.length,
        ts: Date.now(),
      });
      return;
    }
    let changed = false;
    for (const relative of declared) {
      const entry = resolveInsidePlugin(loaded.path, String(relative ?? "").trim());
      if (!entry || !existsSync(entry)) {
        this.services.audit?.({
          pluginId,
          api: "plugin.agentExtensions.skipped",
          ok: false,
          errorCode: "NOT_FOUND",
          ts: Date.now(),
        });
        continue;
      }
      let id = entry;
      try {
        id = realpathSync(entry);
      } catch {
        // Fall back to the resolved path; the sidecar reports a load error.
      }
      this.agentExtensions.set(id, {
        id,
        pluginId,
        pluginName: loaded.manifest.name,
        entry,
        root: loaded.path,
      });
      changed = true;
    }
    if (changed) this.services.agentExtensionsChanged?.();
  }

  private registerSkills(loaded: LoadedPlugin): void {
    const declared = loaded.manifest.contributes?.skills ?? [];
    if (!declared.length) return;
    const pluginId = loaded.manifest.id;
    if (!loaded.permissions.has("agent.prompt.inject")) {
      this.services.audit?.({
        pluginId,
        api: "plugin.skills.skipped",
        ok: false,
        errorCode: "PERMISSION_DENIED",
        count: declared.length,
        ts: Date.now(),
      });
      return;
    }

    let accepted = 0;
    for (const entry of declared) {
      if (accepted >= MAX_SKILLS_PER_PLUGIN) {
        this.services.audit?.({
          pluginId,
          api: "plugin.skills.skipped",
          ok: false,
          errorCode: "LIMIT_EXCEEDED",
          count: declared.length - accepted,
          ts: Date.now(),
        });
        break;
      }
      const contrib: PluginSkillContrib =
        typeof entry === "string" ? { path: entry } : entry;
      const relative = String(contrib.path ?? "").trim();
      if (!relative) continue;
      const skillPath = resolveInsidePlugin(loaded.path, relative);
      if (!skillPath || !existsSync(skillPath)) {
        this.skipSkill(pluginId, relative, "NOT_FOUND");
        continue;
      }
      let raw: string;
      try {
        const stats = statSync(skillPath);
        if (stats.size > MAX_SKILL_BYTES) {
          this.skipSkill(pluginId, relative, "TOO_LARGE");
          continue;
        }
        raw = readFileSync(skillPath, "utf8");
      } catch {
        this.skipSkill(pluginId, relative, "READ_FAILED");
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed.body) {
        this.skipSkill(pluginId, relative, "EMPTY");
        continue;
      }
      const skillId = String(contrib.id ?? "").trim() || skillIdFromPath(relative);
      const id = pluginSkillId(pluginId, skillId);
      if (this.skills.has(id)) {
        this.skipSkill(pluginId, relative, "DUPLICATE");
        continue;
      }
      const description = (contrib.description ?? parsed.description ?? "").trim();
      this.skills.set(id, {
        id,
        pluginId,
        skillId,
        name: (contrib.name ?? parsed.name ?? skillId).trim() || skillId,
        description:
          description.length > MAX_SKILL_DESCRIPTION_CHARS
            ? `${description.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1).trimEnd()}…`
            : description,
        path: skillPath,
        bytes: Buffer.byteLength(raw, "utf8"),
      });
      accepted += 1;
    }
    if (accepted) {
      this.services.audit?.({
        pluginId,
        api: "plugin.skills.register",
        ok: true,
        count: accepted,
        ts: Date.now(),
      });
    }
  }

  private skipSkill(pluginId: string, path: string, errorCode: string): void {
    this.services.audit?.({
      pluginId,
      api: "plugin.skills.skipped",
      ok: false,
      errorCode,
      path,
      ts: Date.now(),
    });
  }

  /**
   * Index `contributes.themes`. Like skills this is declarative, but the CSS is
   * read and sanitized here so a bad sheet never reaches the renderer: the
   * shell injects the stored text with no further filtering.
   */
  private registerThemes(loaded: LoadedPlugin): void {
    const declared = loaded.manifest.contributes?.themes ?? [];
    if (!declared.length) return;
    const pluginId = loaded.manifest.id;
    if (!loaded.permissions.has("ui.theme")) {
      this.services.audit?.({
        pluginId,
        api: "plugin.themes.skipped",
        ok: false,
        errorCode: "PERMISSION_DENIED",
        count: declared.length,
        ts: Date.now(),
      });
      return;
    }

    // The native window background is a separate grant: a plugin may contribute
    // themes and ask for neither, and a plugin that asked without the grant is
    // audited rather than silently ignored.
    const windowAppearanceDeclared =
      loaded.manifest.contributes?.windowAppearance !== undefined;
    const windowBackground = loaded.permissions.has("ui.window.appearance")
      ? resolveWindowBackground(loaded.manifest.contributes?.windowAppearance)
      : undefined;
    if (windowAppearanceDeclared && !loaded.permissions.has("ui.window.appearance")) {
      this.services.audit?.({
        pluginId,
        api: "plugin.themes.skipped",
        ok: false,
        errorCode: "PERMISSION_DENIED",
        message: "contributes.windowAppearance requires ui.window.appearance",
        ts: Date.now(),
      });
    }

    let accepted = 0;
    for (const contrib of declared) {
      const themeId = String(contrib?.id ?? "").trim();
      const relative = String(contrib?.path ?? "").trim();
      if (!themeId || !relative) continue;
      if (!THEME_LOCAL_ID_PATTERN.test(themeId)) {
        this.skipTheme(pluginId, themeId, "INVALID_ID");
        continue;
      }
      const cssPath = resolveInsidePlugin(loaded.path, relative);
      if (!cssPath || !existsSync(cssPath)) {
        this.skipTheme(pluginId, themeId, "NOT_FOUND");
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(cssPath, "utf8");
      } catch {
        this.skipTheme(pluginId, themeId, "READ_FAILED");
        continue;
      }
      // Declared assets are the only relative references this theme may make;
      // each one is rewritten to the host scheme so the sheet never carries a
      // path the renderer would resolve itself.
      const assets = resolveThemeAssets(loaded.path, contrib.assets ?? []);
      if (assets.dropped) {
        this.skipTheme(
          pluginId,
          themeId,
          "INVALID_ASSET",
          `${assets.dropped} declared asset(s) ignored`,
        );
      }
      const sanitized = sanitizeThemeCss(raw, THEME_CSS_MAX_BYTES, (target) => {
        const normalized = normalizeThemeAssetPath(target);
        if (!normalized || !assets.files.has(normalized)) return null;
        return themeAssetUrl(pluginId, normalized);
      });
      if (!sanitized.ok) {
        this.skipTheme(pluginId, themeId, "INVALID_CSS", sanitized.error);
        continue;
      }
      const id = pluginThemeId(pluginId, themeId);
      if (this.themes.has(id)) {
        this.skipTheme(pluginId, themeId, "DUPLICATE");
        continue;
      }
      // The registry is per plugin and the resolver above is per theme: a sheet
      // only reaches its own declarations, while the handler can serve any
      // asset this plugin is allowed to have.
      let registry = this.themeAssets.get(pluginId);
      if (!registry) {
        registry = new Map();
        this.themeAssets.set(pluginId, registry);
      }
      for (const [assetPath, absolute] of assets.files) registry.set(assetPath, absolute);
      this.themes.set(id, {
        id,
        pluginId,
        themeId,
        label: String(contrib.label ?? "").trim() || themeId,
        base: contrib.base === "light" ? "light" : "dark",
        css: sanitized.css,
        ...(contrib.variables?.length
          ? { variablesCss: this.themeVariablesCss(loaded, id, contrib.variables) }
          : {}),
        ...(windowBackground ? { windowBackground } : {}),
      });
      accepted += 1;
    }
    if (accepted) {
      this.services.audit?.({
        pluginId,
        api: "plugin.themes.register",
        ok: true,
        count: accepted,
        ts: Date.now(),
      });
    }
  }

  private themeVariablesCss(
    loaded: LoadedPlugin,
    themeId: string,
    declarations: readonly PluginThemeVariableContrib[],
  ): string {
    const values = this.readThemeVariableValues(loaded, themeId);
    try {
      return formatPluginThemeVariables(
        themeId,
        declarations,
        normalizePluginThemeVariableValues(declarations, values),
      );
    } catch {
      // An old/corrupt private record cannot make a declared theme unavailable.
      return formatPluginThemeVariables(
        themeId,
        declarations,
        normalizePluginThemeVariableValues(declarations, {}),
      );
    }
  }

  private readThemeVariableValues(loaded: LoadedPlugin, themeId: string): Record<string, unknown> {
    try {
      const file = join(this.pluginDataDir(loaded.manifest.id), "settings.json");
      const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const all = settings?.[THEME_VARIABLES_SETTINGS_KEY];
      return all && typeof all === "object" && !Array.isArray(all) && all[themeId] && typeof all[themeId] === "object"
        ? all[themeId] as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private skipTheme(
    pluginId: string,
    themeId: string,
    errorCode: string,
    message?: string,
  ): void {
    this.services.audit?.({
      pluginId,
      api: "plugin.themes.skipped",
      ok: false,
      errorCode,
      themeId,
      ...(message ? { message } : {}),
      ts: Date.now(),
    });
  }

  /**
   * Connect the plugin's declared MCP servers and publish their tools under the
   * plugin's own namespace, so they travel the existing `plugin_*` tool path
   * with no extra routing (ADR 0038).
   *
   * A server that fails to answer is audited and contributes no tools; the
   * plugin still loads, and the next tool call retries the handshake.
   */
  private async registerMcpServers(loaded: LoadedPlugin): Promise<void> {
    const declared = loaded.manifest.contributes?.mcpServers ?? [];
    if (!declared.length) return;
    const pluginId = loaded.manifest.id;
    // Credentials come from the plugin's own settings, never from host env.
    let settings: Record<string, unknown> = {};
    try {
      settings = await this.hostApi(loaded).plugin.getSettings();
    } catch {
      settings = {};
    }

    const clients: McpServerClient[] = [];
    for (const raw of declared) {
      if (clients.length >= MAX_MCP_SERVERS_PER_PLUGIN) {
        this.services.audit?.({
          pluginId,
          api: "plugin.mcp.skipped",
          ok: false,
          errorCode: "LIMIT_EXCEEDED",
          count: declared.length - clients.length,
          ts: Date.now(),
        });
        break;
      }
      const parsed = validateMcpServer(raw);
      if (!parsed.ok) {
        this.skipMcpServer(pluginId, String((raw as { id?: unknown })?.id ?? ""), "PLUGIN_INVALID", parsed.error);
        continue;
      }
      const server = parsed.server;
      const permission =
        server.transport === "stdio" ? "mcp.server.local" : "mcp.server.remote";
      if (!loaded.permissions.has(permission)) {
        this.skipMcpServer(pluginId, server.id, "PERMISSION_DENIED", `missing ${permission}`);
        continue;
      }
      // An http MCP endpoint is an outbound channel like any other, so it
      // answers to the same allowlist rather than to its permission alone.
      if (server.transport === "http") {
        const url = String(server.url ?? "");
        if (!isNetUrlAllowed(url, this.netDomains(loaded))) {
          this.skipMcpServer(
            pluginId,
            server.id,
            "PERMISSION_DENIED",
            `endpoint not in manifest.net.domains: ${url}`,
          );
          continue;
        }
      }
      const refs = resolveMcpRefs(
        server.transport === "stdio" ? server.env : server.headers,
        settings,
      );
      if (!refs.ok) {
        this.skipMcpServer(pluginId, server.id, "CONFIG_MISSING", refs.error);
        continue;
      }

      const client = new McpServerClient({
        pluginId,
        rootPath: loaded.path,
        server,
        values: refs.values,
        audit: this.services.audit,
        ...this.services.mcp,
        // Re-check every redirect, not only the manifest's initial endpoint.
        assertUrlAllowed: (url) => this.assertEgress(loaded, url, "plugin.mcp.redirect"),
      });
      clients.push(client);
      let tools: Awaited<ReturnType<McpServerClient["connect"]>> = [];
      try {
        tools = await client.connect();
      } catch {
        // The client already audited the failure; leave the server toolless.
        continue;
      }
      for (const tool of tools) {
        const name = pluginMcpToolKey(server.id, tool.name);
        const fullName = pluginToolName(pluginId, name);
        this.tools.set(fullName, {
          fullName,
          pluginId,
          name,
          description:
            tool.description ?? `${server.label ?? server.id} tool "${tool.name}" (MCP)`,
          // Remote code the desktop cannot inspect; never silently auto-approved.
          risk: "medium",
          schema: tool.inputSchema,
          execute: async (toolArgs) => client.callTool(tool.name, toolArgs),
        });
      }
    }
    if (clients.length) this.mcpClients.set(pluginId, clients);
  }

  private skipMcpServer(
    pluginId: string,
    serverId: string,
    errorCode: string,
    message?: string,
  ): void {
    this.services.audit?.({
      pluginId,
      api: "plugin.mcp.skipped",
      ok: false,
      errorCode,
      serverId,
      ...(message ? { message } : {}),
      ts: Date.now(),
    });
  }

  /** Declared resident services, capped so one plugin cannot hold many workers. */
  private declaredServices(loaded: LoadedPlugin): PluginServiceContrib[] {
    const declared = loaded.manifest.contributes?.services ?? [];
    return declared.slice(0, MAX_SERVICES_PER_PLUGIN);
  }

  /**
   * Start the plugin's resident services once `onLoad` returned, so the plugin
   * has had its chance to call `pi.services.register` (spec 07 §5).
   *
   * A service that refuses to start is marked failed and left alone: the plugin
   * itself stays loaded, because its commands and tools may still work.
   */
  private async startServices(loaded: LoadedPlugin): Promise<void> {
    const all = loaded.manifest.contributes?.services ?? [];
    if (!all.length) return;
    const pluginId = loaded.manifest.id;
    if (!loaded.permissions.has("background.service")) {
      this.services.audit?.({
        pluginId,
        api: "plugin.services.skipped",
        ok: false,
        errorCode: "PERMISSION_DENIED",
        count: all.length,
        ts: Date.now(),
      });
      return;
    }
    if (all.length > MAX_SERVICES_PER_PLUGIN) {
      this.services.audit?.({
        pluginId,
        api: "plugin.services.skipped",
        ok: false,
        errorCode: "LIMIT_EXCEEDED",
        count: all.length - MAX_SERVICES_PER_PLUGIN,
        ts: Date.now(),
      });
    }
    const restarts = this.restarts.get(pluginId)?.attempts ?? 0;
    for (const service of this.declaredServices(loaded)) {
      const label = service.label || service.id;
      this.setServiceState({
        pluginId,
        serviceId: service.id,
        label,
        state: "starting",
        restarts,
      });
      try {
        await this.sendToChild(
          loaded,
          { t: "call", method: "service.start", payload: { id: service.id } },
          SERVICE_START_TIMEOUT_MS,
        );
        this.setServiceState({
          pluginId,
          serviceId: service.id,
          label,
          state: "running",
          restarts,
        });
        this.services.audit?.({
          pluginId,
          api: "plugin.service.start",
          ok: true,
          serviceId: service.id,
          ts: Date.now(),
        });
      } catch (error) {
        this.setServiceState({
          pluginId,
          serviceId: service.id,
          label,
          state: "failed",
          restarts,
          message: (error as Error).message,
        });
        this.services.audit?.({
          pluginId,
          api: "plugin.service.start",
          ok: false,
          serviceId: service.id,
          errorCode: (error as PluginApiError).code ?? "SERVICE_START_FAILED",
          message: (error as Error).message,
          ts: Date.now(),
        });
      }
    }
    // Surviving the grace window means the backoff can start from zero again.
    if (restarts > 0) this.scheduleHealthyReset(pluginId);
  }

  /** Ask the child to stop its services, then forget them: the plugin is going. */
  private async stopServices(loaded: LoadedPlugin): Promise<void> {
    const pluginId = loaded.manifest.id;
    for (const service of this.declaredServices(loaded)) {
      const key = serviceStateKey(pluginId, service.id);
      const current = this.serviceStates.get(key);
      if (!current) continue;
      if (current.state === "running" || current.state === "starting") {
        try {
          await this.sendToChild(
            loaded,
            { t: "call", method: "service.stop", payload: { id: service.id } },
            PLUGIN_HOOK_TIMEOUT_MS,
          );
        } catch {
          // The child is killed right after this; a stuck stop must not block.
        }
      }
      this.serviceStates.delete(key);
      this.services.onServiceChange?.({ ...current, state: "stopped", updatedAt: Date.now() });
      this.services.audit?.({
        pluginId,
        api: "plugin.service.stop",
        ok: true,
        serviceId: service.id,
        ts: Date.now(),
      });
    }
  }

  private markServices(
    loaded: LoadedPlugin,
    state: PluginServiceStatus["state"],
    restarts: number,
    message?: string,
  ): void {
    for (const service of this.declaredServices(loaded)) {
      this.setServiceState({
        pluginId: loaded.manifest.id,
        serviceId: service.id,
        label: service.label || service.id,
        state,
        restarts,
        ...(message ? { message } : {}),
      });
    }
  }

  private setServiceState(status: Omit<PluginServiceStatus, "updatedAt">): void {
    const next: PluginServiceStatus = { ...status, updatedAt: Date.now() };
    this.serviceStates.set(serviceStateKey(status.pluginId, status.serviceId), next);
    this.services.onServiceChange?.(next);
  }

  private scheduleHealthyReset(pluginId: string): void {
    const record = this.restarts.get(pluginId);
    if (!record) return;
    if (record.healthy) clearTimeout(record.healthy);
    record.healthy = setTimeout(() => {
      this.restarts.delete(pluginId);
    }, SERVICE_HEALTHY_MS);
    // Supervision must never be the reason the process stays alive.
    record.healthy.unref?.();
  }

  private cancelRestarts(pluginId: string): void {
    const record = this.restarts.get(pluginId);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    if (record.healthy) clearTimeout(record.healthy);
    this.restarts.delete(pluginId);
  }

  /**
   * Fan one message out to the plugins subscribed to its topic (spec 07 §3).
   *
   * The publisher is excluded: a plugin talking to itself needs no bus, and
   * echoing its own messages back is a surprising default. Delivery is
   * fire-and-forget — a slow or wedged subscriber must never stall the sender.
   */
  private async busPublish(
    loaded: LoadedPlugin,
    topic: unknown,
    payload?: unknown,
  ): Promise<{ ok: true; delivered: number }> {
    const pluginId = loaded.manifest.id;
    this.assertPermission(loaded, "bus.publish");
    const name = String(topic ?? "");
    if (!isValidBusTopic(name)) {
      throw apiError("INVALID_ARGUMENT", `invalid bus topic: ${name}`);
    }
    if (!busTopicAllowed(loaded.manifest.contributes?.bus?.publish, name)) {
      this.auditBus(pluginId, "bus.publish", false, name, "TOPIC_NOT_DECLARED");
      throw apiError("PERMISSION_DENIED", `topic not declared for publish: ${name}`);
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(payload ?? null);
    } catch {
      throw apiError("INVALID_ARGUMENT", "bus payload is not serializable");
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_BUS_PAYLOAD_BYTES) {
      this.auditBus(pluginId, "bus.publish", false, name, "PAYLOAD_TOO_LARGE");
      throw apiError("INVALID_ARGUMENT", "bus payload too large");
    }
    if (this.busRateExceeded(pluginId)) {
      this.auditBus(pluginId, "bus.publish", false, name, "RATE_LIMITED");
      throw apiError("RATE_LIMITED", "bus publish rate exceeded");
    }

    const message = {
      topic: name,
      from: pluginId,
      payload: payload ?? undefined,
      at: new Date().toISOString(),
    };
    let delivered = 0;
    for (const subscription of this.busSubscriptions.values()) {
      if (subscription.pluginId === pluginId) continue;
      if (!matchesBusTopic(subscription.pattern, name)) continue;
      const target = this.loaded.get(subscription.pluginId);
      if (!target?.child || target.disposing) continue;
      try {
        target.child.postMessage({
          t: "event",
          event: "bus.message",
          subscriptionId: subscription.id,
          message,
        });
        delivered += 1;
      } catch {
        // The subscriber is going away; its subscription dies with it.
      }
    }
    this.services.audit?.({
      pluginId,
      api: "plugin.bus.publish",
      ok: true,
      topic: name,
      delivered,
      ts: Date.now(),
    });
    return { ok: true, delivered };
  }

  private async busSubscribe(
    loaded: LoadedPlugin,
    pattern: unknown,
  ): Promise<{ subscriptionId: string; pattern: string }> {
    const pluginId = loaded.manifest.id;
    this.assertPermission(loaded, "bus.subscribe");
    const name = String(pattern ?? "");
    if (!isValidBusTopicPattern(name)) {
      throw apiError("INVALID_ARGUMENT", `invalid bus topic pattern: ${name}`);
    }
    if (!busSubscribeAllowed(loaded.manifest.contributes?.bus?.subscribe, name)) {
      this.auditBus(pluginId, "bus.subscribe", false, name, "TOPIC_NOT_DECLARED");
      throw apiError("PERMISSION_DENIED", `topic not declared for subscribe: ${name}`);
    }
    let held = 0;
    for (const subscription of this.busSubscriptions.values()) {
      if (subscription.pluginId === pluginId) held += 1;
    }
    if (held >= MAX_BUS_SUBSCRIPTIONS_PER_PLUGIN) {
      this.auditBus(pluginId, "bus.subscribe", false, name, "LIMIT_EXCEEDED");
      throw apiError("LIMIT_EXCEEDED", "too many bus subscriptions");
    }
    const id = `bus${this.nextBusSubscription++}`;
    this.busSubscriptions.set(id, { id, pluginId, pattern: name });
    this.auditBus(pluginId, "bus.subscribe", true, name);
    return { subscriptionId: id, pattern: name };
  }

  private async busUnsubscribe(
    loaded: LoadedPlugin,
    subscriptionId: unknown,
  ): Promise<{ ok: true }> {
    const id = String(subscriptionId ?? "");
    const subscription = this.busSubscriptions.get(id);
    // Only the owner may drop a subscription, and dropping twice is fine.
    if (subscription && subscription.pluginId === loaded.manifest.id) {
      this.busSubscriptions.delete(id);
      this.auditBus(loaded.manifest.id, "bus.unsubscribe", true, subscription.pattern);
    }
    return { ok: true };
  }

  /** Rolling publish window per plugin; the first publish opens the window. */
  private busRateExceeded(pluginId: string): boolean {
    const now = Date.now();
    const record = this.busRate.get(pluginId);
    if (!record || now - record.windowStart >= BUS_RATE_WINDOW_MS) {
      this.busRate.set(pluginId, { windowStart: now, count: 1 });
      return false;
    }
    record.count += 1;
    return record.count > MAX_BUS_PUBLISH_PER_WINDOW;
  }

  private auditBus(
    pluginId: string,
    api: string,
    ok: boolean,
    topic: string,
    errorCode?: string,
  ): void {
    this.services.audit?.({
      pluginId,
      api: `plugin.${api}`,
      ok,
      topic,
      ...(errorCode ? { errorCode } : {}),
      ts: Date.now(),
    });
  }

  /**
   * The plugin's egress allowlist. A malformed `net.domains` degrades to "no
   * egress" rather than "all egress": validateManifest already rejects it at
   * install, so reaching this fallback means the manifest changed underneath us.
   */
  private netDomains(loaded: LoadedPlugin): string[] {
    const parsed = parseNetDomains(loaded.manifest.net?.domains);
    return parsed.ok ? (parsed.domains ?? []) : [];
  }

  /**
   * Confine one outbound URL to the allowlist. Reading a secret only becomes a
   * leak when it can leave, so every host-owned egress path funnels through
   * here — and an undeclared `net.domains` means nothing leaves at all.
   */
  private assertEgress(loaded: LoadedPlugin, url: string, api: string): void {
    const domains = this.netDomains(loaded);
    if (isNetUrlAllowed(url, domains)) return;
    this.refuseEgress(loaded, url, api, domains);
  }

  /**
   * The socket half of the same check: `ws` and `wss` are admissible schemes,
   * the allowlist and the audit entry are identical, and refusing here means
   * the transport never opens a connection to an undeclared host.
   */
  private assertSocketEgress(loaded: LoadedPlugin, url: string): void {
    const domains = this.netDomains(loaded);
    if (isNetSocketUrlAllowed(url, domains)) return;
    this.refuseEgress(loaded, url, "net.websocket.connect", domains);
  }

  /** One refusal path for both schemes: same audit shape, same message. */
  private refuseEgress(
    loaded: LoadedPlugin,
    url: string,
    api: string,
    domains: readonly string[],
  ): void {
    let host = url;
    try {
      host = new URL(url).hostname || url;
    } catch {
      // Keep the raw value; the audit entry is more useful than a parse error.
    }
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api,
      ok: false,
      errorCode: "PERMISSION_DENIED",
      url,
      ts: Date.now(),
    });
    throw apiError(
      "PERMISSION_DENIED",
      domains.length
        ? `host not in manifest.net.domains: ${host}`
        : `plugin declares no manifest.net.domains; ${host} is unreachable`,
    );
  }

  /**
   * Forward one socket event to the plugin that owns the socket, when it is
   * still loaded. A frame that arrives after unload is dropped rather than
   * queued for a process that no longer exists.
   */
  deliverSocketEvent(pluginId: string, event: PluginSocketEvent): void {
    const loaded = this.loaded.get(pluginId);
    if (!loaded?.child) return;
    // Addressed to the owner only: frames are one plugin's data and must never
    // reach another plugin's process, which a fan-out would do.
    try {
      loaded.child.postMessage({
        t: "event",
        event: `net:websocket:${event.type}`,
        args: [event],
      });
    } catch (error) {
      this.services.audit?.({
        pluginId,
        api: "net.websocket.deliver",
        ok: false,
        errorCode: "PLUGIN_UNREACHABLE",
        message: (error as Error).message,
        ts: Date.now(),
      });
    }
  }

  private inFlightTool(pluginId: string): PluginToolInvocation | undefined {
    const loaded = this.loaded.get(pluginId);
    return loaded ? this.toolInvocations.current(loaded) : undefined;
  }

  private completeRateExceeded(pluginId: string): boolean {
    const now = Date.now();
    const current = this.completeRate.get(pluginId);
    if (!current || now - current.windowStart >= COMPLETE_RATE_WINDOW_MS) {
      this.completeRate.set(pluginId, { windowStart: now, count: 1 });
      return false;
    }
    current.count += 1;
    return current.count > MAX_COMPLETES_PER_WINDOW;
  }

  private async readSessionContext(loaded: LoadedPlugin): Promise<PluginLlmContext> {
    this.assertPermission(loaded, "session.read");
    const inFlight = this.inFlightTool(loaded.manifest.id);
    const sessionId = inFlight?.sessionId?.trim() ?? "";
    if (!sessionId) {
      throw apiError("INVALID_ARGUMENT", "session context is only available during tool execution");
    }
    if (!this.services.getSessionContext) {
      throw apiError("UNSUPPORTED", "host api not available: session.getLlmContext");
    }
    const stripToolName = inFlight?.toolName
      ? pluginToolName(loaded.manifest.id, inFlight.toolName)
      : undefined;
    const context = await this.services.getSessionContext(sessionId, stripToolName);
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api: "session.getLlmContext",
      ok: true,
      sessionId,
      count: context.messages.length,
      truncated: context.truncated,
      ts: Date.now(),
    });
    return context;
  }

  private async runAgentComplete(
    loaded: LoadedPlugin,
    input: PluginCompleteInput,
  ): Promise<PluginCompleteResult> {
    this.assertPermission(loaded, "agent.complete");
    const modelKey = String(input.modelKey ?? "").trim();
    if (!modelKey || !modelKey.includes("/")) {
      throw apiError("INVALID_ARGUMENT", "modelKey must be providerId/modelId");
    }
    const system = typeof input.system === "string" ? input.system : "";
    if (system.length > MAX_COMPLETE_SYSTEM_CHARS) {
      throw apiError("INVALID_ARGUMENT", "system prompt exceeds 32 KiB");
    }
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const messageChars = messages.reduce(
      (sum, message) => sum + String(message?.content ?? "").length,
      0,
    );
    if (messageChars > MAX_COMPLETE_MESSAGE_CHARS) {
      throw apiError("INVALID_ARGUMENT", "messages exceed 200k characters");
    }
    if (this.completeRateExceeded(loaded.manifest.id)) {
      this.services.audit?.({
        pluginId: loaded.manifest.id,
        api: "agent.complete",
        ok: false,
        errorCode: "RATE_LIMITED",
        ts: Date.now(),
      });
      throw apiError("RATE_LIMITED", "plugin completion rate exceeded");
    }
    const includeSessionContext = input.includeSessionContext === true;
    if (includeSessionContext) {
      this.assertPermission(loaded, "session.read");
    }
    const inFlight = this.inFlightTool(loaded.manifest.id);
    if (includeSessionContext && !inFlight?.sessionId) {
      throw apiError("INVALID_ARGUMENT", "session context is only available during tool execution");
    }
    if (!this.services.complete) {
      throw apiError("UNSUPPORTED", "host api not available: agent.complete");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLUGIN_COMPLETE_TIMEOUT_MS);
    let result: PluginCompleteResult;
    try {
      result = await this.services.complete({
        modelKey,
        thinkingLevel: input.thinkingLevel,
        system: system || undefined,
        messages,
        includeSessionContext,
        sessionId: inFlight?.sessionId,
        stripToolName: inFlight?.toolName
          ? pluginToolName(loaded.manifest.id, inFlight.toolName)
          : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.services.audit?.({
          pluginId: loaded.manifest.id,
          api: "agent.complete",
          ok: false,
          errorCode: "TIMEOUT",
          ts: Date.now(),
        });
        throw apiError("TIMEOUT", "plugin completion timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api: "agent.complete",
      ok: true,
      modelKey: result.modelKey,
      systemChars: system.length,
      messageChars,
      outputChars: result.text.length,
      usage: result.usage,
      ts: Date.now(),
    });
    return result;
  }

  /**
   * Per-plugin data directory. Host-owned; the fs API cannot reach it.
   *
   * Electron main publishes the resolved data directory to
   * `PI_DESKTOP_DATA_DIR` at boot, so this reads the installation's own root
   * and a development host never writes plugin data into the packaged
   * profile's tree (D236).
   */
  private pluginDataDir(pluginId: string): string {
    const root = desktopDataDir();
    return join(root, "plugins", "data", pluginId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  }

  private browserSessionId(pluginId?: string): string | undefined {
    return pluginId ? this.inFlightTool(pluginId)?.sessionId.trim() || undefined : undefined;
  }

  private async invokeBrowser(
    loaded: LoadedPlugin,
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertPermission(loaded, "browser.cdp");
    const api = this.hostApi(loaded).browser;
    switch (method) {
      case "navigate":
        return api.navigate({
          url: payload?.url != null ? String(payload.url) : undefined,
          path: payload?.path != null ? String(payload.path) : undefined,
        });
      case "action": {
        const action = String(payload?.action ?? "");
        if (
          action === "back" ||
          action === "forward" ||
          action === "reload" ||
          action === "stop"
        ) {
          api.action(action);
        }
        return { ok: true };
      }
      case "setBounds":
        return api.setBounds(payload);
      case "setVisible":
        api.setVisible(payload?.visible === true);
        return { ok: true };
      case "getState":
        return api.getState();
      case "openExternal":
        api.openExternal();
        return { ok: true };
      case "snapshot":
        return api.snapshot();
      case "screenshot":
        return api.screenshot({ fullPage: payload?.fullPage === true });
      case "click":
        await api.click(String(payload?.uid ?? ""));
        return { ok: true };
      case "fill":
        await api.fill(String(payload?.uid ?? ""), String(payload?.text ?? ""));
        return { ok: true };
      case "evaluate":
        return api.evaluate(String(payload?.expression ?? ""));
      case "console":
        return api.console(
          typeof payload?.limit === "number" ? payload.limit : undefined,
        );
      case "cdp":
        return api.cdp(String(payload?.method ?? ""), payload?.params);
      default:
        throw apiError("UNSUPPORTED", `host api not available: browser.${method}`);
    }
  }

  private assertPermission(loaded: LoadedPlugin, perm: string): void {
    this.toolInvocations.current(loaded);
    if (!loaded.permissions.has(perm)) {
      this.services.audit?.({
        pluginId: loaded.manifest.id,
        api: perm,
        ok: false,
        errorCode: "PERMISSION_DENIED",
        ts: Date.now(),
      });
      throw apiError("PERMISSION_DENIED", `missing permission: ${perm}`);
    }
  }

  private sessionSource(
    loaded: LoadedPlugin,
    rawSource: unknown,
  ): { id: string; label?: string } {
    const source = typeof rawSource === "string" ? rawSource.trim() : "";
    const entry = (loaded.manifest.contributes?.sessionSources ?? []).find(
      (candidate) => candidate.id === source,
    );
    if (!entry) {
      throw apiError("PERMISSION_DENIED", "session source is not declared by the manifest");
    }
    return {
      id: entry.id,
      label: resolvePluginLocalizedString(entry.label, this.services.getLocale?.(), entry.id),
    };
  }

  /**
   * Turn a real panel drop into a one-file, read-only grant. The panel host
   * proves the gesture; this method still re-resolves and rechecks the path so
   * a symlink or a protected file cannot turn that gesture into broader reach.
   */
  private registerDroppedFile(
    loaded: LoadedPlugin,
    requestPath: string,
    droppedPath?: string,
  ): { grantId: string } {
    this.assertPermission(loaded, "fs.read");
    if (!droppedPath || !isAbsolute(requestPath) || resolve(requestPath) !== resolve(droppedPath)) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", "file was not dropped into this plugin panel");
    }
    let full: string;
    try {
      full = realpathSync(requestPath);
      if (!statSync(full).isFile()) throw new Error("not a file");
    } catch {
      this.auditFs(loaded, "read", requestPath, "NOT_FOUND");
      throw apiError("NOT_FOUND", `cannot register dropped file: ${requestPath}`);
    }
    if (this.isProtectedPath(full) || isDeniedFsPath(normalizeFsPath(full))) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", "dropped path is reserved by the app");
    }
    const grantId = randomUUID();
    loaded.dropGrants.set(grantId, { fullPath: full, requestPath: resolve(requestPath) });
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api: "fs.registerDropped",
      ok: true,
      ts: Date.now(),
      path: `<dropped>/${basename(full)}`,
    });
    return { grantId };
  }

  /**
   * The directory one fs call resolves against.
   *
   * A `userSelected` mode keeps the directory the user picked. Every other mode
   * resolves the project of the session that invoked the tool: two sessions can
   * sit on two projects at once, so the visible workspace is a fallback only --
   * for a panel call, which has no tool session, and for a session the host has
   * not launched yet.
   */
  private fsRoot(loaded: LoadedPlugin, rule: PluginFsRule): string | null {
    if (rule.root === "userSelected") return loaded.userRoot ?? null;
    const sessionId = this.inFlightTool(loaded.manifest.id)?.sessionId.trim() || undefined;
    const scoped = sessionId
      ? (this.services.getWorkspacePathForSession?.(sessionId) ?? null)
      : null;
    return scoped ?? this.services.getWorkspacePath();
  }

  /**
   * Resolve one file request and decide whether it may proceed.
   *
   * Four gates in a fixed order, because each one is only sound behind the
   * previous: the permission says the plugin may touch files at all;
   * containment says the path is really inside its root (through links, not
   * just lexically); the deny-list refuses credentials under every grant; and
   * only then does the declared scope -- or the user -- decide.
   */
  private async resolveFsRequest(
    loaded: LoadedPlugin,
    mode: PluginFsMode,
    requestPath: string,
    options: { create?: boolean; dropGrantId?: string } = {},
  ): Promise<{ full: string; rel: string; root: string }> {
    this.assertPermission(loaded, `fs.${mode}`);
    if (typeof options.dropGrantId === "string") {
      if (mode !== "read") {
        throw apiError("PERMISSION_DENIED", "dropped-file grants are read-only");
      }
      const grant = loaded.dropGrants.get(options.dropGrantId);
      if (!grant) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "dropped-file grant is missing or expired");
      }
      if (!isAbsolute(requestPath) || resolve(requestPath) !== grant.requestPath) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "path does not match the dropped-file grant");
      }
      let full = grant.fullPath;
      try {
        full = realpathSync(full);
      } catch {
        this.auditFs(loaded, mode, requestPath, "NOT_FOUND");
        throw apiError("NOT_FOUND", `path not found: ${requestPath}`);
      }
      let requestedFull: string;
      try {
        requestedFull = realpathSync(requestPath);
      } catch {
        this.auditFs(loaded, mode, requestPath, "NOT_FOUND");
        throw apiError("NOT_FOUND", `path not found: ${requestPath}`);
      }
      if (full !== grant.fullPath || requestedFull !== grant.fullPath || !statSync(full).isFile()) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "dropped file was replaced");
      }
      if (this.isProtectedPath(full) || isDeniedFsPath(normalizeFsPath(full))) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "dropped path is reserved by the app");
      }
      return { full, rel: `<dropped>/${basename(full)}`, root: dirname(full) };
    }
    const rule: PluginFsRule = loaded.fsPolicy[mode] ?? { root: "workspace", scope: [] };
    const root = this.fsRoot(loaded, rule);
    if (!root) {
      throw apiError(
        "NOT_FOUND",
        rule.root === "userSelected"
          ? "no directory has been chosen; call fs.requestDirectory first"
          : "No workspace is open",
      );
    }

    const full = options.create
      ? await resolveRealPathForCreateWithinRoot(root, requestPath)
      : await resolveRealPathWithinRoot(root, requestPath);
    if (!full) {
      // A path that simply is not there gets said so. Only a path that exists
      // and resolves outside the root is an escape, and telling a plugin author
      // with a typo that they tried to escape the workspace is a lie that costs
      // them an afternoon.
      const lexical = !options.create && resolveWithinRoot(root, requestPath);
      const missing = Boolean(lexical) && !existsSync(lexical as string);
      const code = missing ? "NOT_FOUND" : "INVALID_ARGUMENT";
      this.auditFs(loaded, mode, requestPath, code);
      throw apiError(
        code,
        missing
          ? `path not found: ${requestPath}`
          : `path escapes the plugin's root: ${requestPath}`,
      );
    }
    // Both sides have to be resolved through links or the relative path comes
    // out as an escape whenever the root itself sits behind one, which is the
    // normal shape of a temp directory on macOS.
    const rootReal = realpathOrSelf(root);
    const rel = normalizeFsPath(relative(rootReal, full));

    if (this.isProtectedPath(full)) {
      this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", "path is reserved by the app");
    }
    if (isDeniedFsPath(rel)) {
      this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
      throw apiError(
        "PERMISSION_DENIED",
        `credentials and repository internals are never readable by plugins: ${rel}`,
      );
    }

    // A directory the user pointed at is the grant; there is nothing narrower
    // to declare, so no scope is required inside it.
    if (rule.root === "userSelected") return { full, rel, root: rootReal };
    if (isFsPathInScope(rel, rule.scope)) return { full, rel, root: rootReal };
    if (mode === "delete" && rule.own && this.ownsWrite(loaded, full)) {
      return { full, rel, root: rootReal };
    }

    await this.requestFsConsent(loaded, mode, rel, full, "scope");
    return { full, rel, root: rootReal };
  }

  /**
   * Resolve a request that names a file in another folder of the open project
   * (ADR 0249, ADR 0263, ADR 0264). A view browsing a sibling folder can only
   * address that folder's entries absolutely, and the two host-mediated actions
   * it offers for them (fs.openDefault, fs.reveal) are the only requests that
   * arrive that way. The widening is narrow: only for a plugin whose declared
   * root is the workspace, only for an absolute path already inside one of the
   * project's registered folder roots (resolved through links, so a symlink
   * cannot carry it out of the folder that contains it), with the declared scope
   * matched against the path relative to the folder that answered, and with the
   * same protected-path and credential guards every other request passes. No
   * file content travels back through this route: it asks the OS to show a file
   * the user right-clicked. Null means it is not such a request, and the caller
   * falls back to the ordinary rooted resolution and its refusal.
   */
  private async resolveRegisteredFolderRequest(
    loaded: LoadedPlugin,
    requestPath: string,
  ): Promise<{ full: string; rel: string; root: string } | null> {
    if (!isAbsolute(String(requestPath ?? ""))) return null;
    const rule: PluginFsRule = loaded.fsPolicy.read ?? { root: "workspace", scope: [] };
    if (rule.root !== "workspace") return null;
    const roots = (this.services.getWorkspaceInfo?.()?.roots ?? [])
      .map((entry) => entry?.path)
      .filter((path): path is string => Boolean(path));
    if (roots.length === 0) return null;
    this.assertPermission(loaded, "fs.read");

    const wanted = resolve(String(requestPath));
    const matches: Array<{ full: string; rel: string; root: string }> = [];
    for (const candidate of roots) {
      const base = resolve(candidate);
      const lexical = relative(base, wanted);
      if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) continue;
      const resolved = await resolveRealPathWithinRoot(base, lexical);
      if (!resolved) continue;
      const rootReal = realpathOrSelf(base);
      matches.push({
        full: resolved,
        rel: normalizeFsPath(relative(rootReal, resolved)),
        root: rootReal,
      });
    }
    if (matches.length === 0) return null;
    // Folders may be nested in one another; the innermost is the one the user is
    // actually looking at.
    const hit = matches.reduce((best, current) => (current.rel.length < best.rel.length ? current : best));
    if (this.isProtectedPath(hit.full) || isDeniedFsPath(hit.rel)) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError(
        "PERMISSION_DENIED",
        `credentials and repository internals are never readable by plugins: ${hit.rel}`,
      );
    }
    if (!isFsPathInScope(hit.rel, rule.scope)) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", `outside manifest.fs.read.scope: ${hit.rel}`);
    }
    return hit;
  }

  /**
   * Whether the path lies under something the host keeps for itself. Both
   * sides are resolved through links, or a barrier reached the other way
   * around simply would not match.
   */
  private isProtectedPath(full: string): boolean {
    for (const guarded of this.services.protectedPaths?.() ?? []) {
      const barrier = realpathOrSelf(guarded);
      if (full === barrier || full.startsWith(barrier + sep)) return true;
    }
    return false;
  }

  /**
   * Ask the user, and remember the answer for the containing directory when
   * they say so. Without a consent service the access is simply refused: a
   * host that cannot ask must not assume yes.
   */
  private async requestFsConsent(
    loaded: LoadedPlugin,
    mode: PluginFsMode,
    rel: string,
    full: string,
    reason: "scope" | "rate",
  ): Promise<void> {
    const pluginId = loaded.manifest.id;
    const key = `${mode}:${reason === "rate" ? "*" : dirname(full)}`;
    if (this.fsConsent.get(pluginId)?.has(key)) return;
    const ask = this.services.confirmFsAccess;
    if (!ask) {
      this.auditFs(loaded, mode, rel, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", `outside manifest.fs.${mode}.scope: ${rel}`);
    }
    const answer = await ask({
      pluginId,
      pluginName: loaded.manifest.name,
      mode,
      path: rel,
      fullPath: full,
      reason,
    });
    if (answer === "deny") {
      this.auditFs(loaded, mode, rel, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", `the user refused ${mode} on ${rel}`);
    }
    if (answer === "session") {
      const grants = this.fsConsent.get(pluginId) ?? new Set<string>();
      grants.add(key);
      this.fsConsent.set(pluginId, grants);
    }
    this.services.audit?.({
      pluginId,
      api: `fs.${mode}`,
      ok: true,
      ts: Date.now(),
      path: rel,
      data: { consent: answer, reason },
    });
  }

  private auditFs(
    loaded: LoadedPlugin,
    mode: PluginFsMode,
    path: string,
    errorCode: string,
  ): void {
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api: `fs.${mode}`,
      ok: false,
      errorCode,
      ts: Date.now(),
      path,
    });
  }

  /** Absolute path of one plugin's write ledger. */
  private ledgerPath(loaded: LoadedPlugin): string {
    return join(this.pluginDataDir(loaded.manifest.id), WRITE_LEDGER_FILE);
  }

  /**
   * Paths this plugin wrote, mapped to the mtime it left behind. Kept on disk
   * so `fs.delete.own` survives a restart, and host-owned so the plugin API
   * cannot reach it. (A plugin process can still touch the file directly --
   * that is the same advisory limit every permission has until the plugin
   * runtime itself is sandboxed, and it grants nothing `node:fs` would not.)
   */
  private readLedger(loaded: LoadedPlugin): Record<string, number> {
    const cached = this.writeLedgers.get(loaded.manifest.id);
    if (cached) return cached;
    let ledger: Record<string, number> = {};
    try {
      const raw = JSON.parse(readFileSync(this.ledgerPath(loaded), "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [path, mtime] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof mtime === "number") ledger[path] = mtime;
        }
      }
    } catch {
      ledger = {};
    }
    this.writeLedgers.set(loaded.manifest.id, ledger);
    return ledger;
  }

  /** Record a write so the plugin can clean up after itself later. */
  private recordWrite(loaded: LoadedPlugin, full: string): void {
    const ledger = this.readLedger(loaded);
    let mtime = Date.now();
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      // Keep the wall clock; the ownership check tolerates a coarse value.
    }
    ledger[full] = mtime;
    const keys = Object.keys(ledger);
    if (keys.length > MAX_WRITE_LEDGER_ENTRIES) {
      for (const stale of keys.slice(0, keys.length - MAX_WRITE_LEDGER_ENTRIES)) {
        delete ledger[stale];
      }
    }
    try {
      const dir = this.pluginDataDir(loaded.manifest.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.ledgerPath(loaded), JSON.stringify(ledger), "utf8");
    } catch {
      // A ledger we cannot persist only costs the plugin its own-delete
      // shortcut on the next run; it never widens anything.
    }
  }

  /**
   * Whether the plugin wrote this exact file and nobody has touched it since.
   * A newer mtime means the user edited it, which makes it the user's file
   * again and sends the delete to a prompt.
   */
  private ownsWrite(loaded: LoadedPlugin, full: string): boolean {
    const recorded = this.readLedger(loaded)[full];
    if (recorded === undefined) return false;
    try {
      // One second of slack: some filesystems round mtime down.
      return statSync(full).mtimeMs <= recorded + 1000;
    } catch {
      return false;
    }
  }

  /** Rolling delete window per plugin, mirroring the bus publish brake. */
  private deleteRateExceeded(loaded: LoadedPlugin): boolean {
    const now = Date.now();
    loaded.deletes = loaded.deletes.filter((at) => now - at < DELETE_RATE_WINDOW_MS);
    loaded.deletes.push(now);
    return loaded.deletes.length > MAX_DELETES_PER_WINDOW;
  }

  /** Host-side implementation of the allowlisted APIs; shared with panel bridge. */
  /**
   * The audio surface fails closed. The permission gate runs first, so an
   * ungranted plugin gets the same `PERMISSION_DENIED` as any other API, and a
   * granted one gets an audited `UNSUPPORTED` instead of a silent success or an
   * uncoded crash. Nothing here touches a device.
   */
  private refuseAudio(loaded: LoadedPlugin, api: string): never {
    this.assertPermission(
      loaded,
      AUDIO_PLAYBACK_APIS.has(api) ? "audio.playback.background" : "audio.capture.background",
    );
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api,
      ok: false,
      errorCode: "UNSUPPORTED",
      ts: Date.now(),
    });
    throw apiError("UNSUPPORTED", `host api not available: ${api}`);
  }

  private hostApi(loaded: LoadedPlugin) {
    const pluginId = loaded.manifest.id;
    const pluginPath = loaded.path;

    const dataPath = () => {
      const dir = this.pluginDataDir(pluginId);
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    return {
      app: {
        getVersion: async () => this.services.getAppVersion?.() ?? "0.2.1",
        getLocale: async () => this.services.getLocale?.() ?? "en",
        getAppearance: async () =>
          this.services.getAppearance?.() ?? {
            theme: "system",
            base: "system",
            locale: this.services.getLocale?.() ?? "en",
            pluginTheme: null,
          },
        setTheme: async (themeId: string) => {
          this.assertPermission(loaded, "ui.theme");
          const raw = String(themeId ?? "").trim();
          const isBuiltin =
            raw === "system" || raw === "light" || raw === "dark";
          if (!isBuiltin && !this.themes.has(raw)) {
            throw apiError("INVALID_ARGUMENT", `unknown theme id: ${raw || "(empty)"}`);
          }
          if (!this.services.setThemePreference) {
            throw apiError("UNSUPPORTED", "host api not available: app.setTheme");
          }
          await this.services.setThemePreference(raw);
          this.services.audit?.({
            pluginId,
            api: "app.setTheme",
            ok: true,
            theme: raw,
            ts: Date.now(),
          });
        },
      },
      themes: {
        upsert: async (input: {
          id: string;
          label: string;
          base: "light" | "dark";
          css: string;
        }) => {
          this.assertPermission(loaded, "ui.theme");
          const themeId = String(input?.id ?? "").trim();
          if (!THEME_LOCAL_ID_PATTERN.test(themeId)) {
            throw apiError(
              "INVALID_ARGUMENT",
              `theme id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}: ${themeId}`,
            );
          }
          const base = input?.base === "light" ? "light" : "dark";
          const label = String(input?.label ?? "").trim() || themeId;
          const rawCss = String(input?.css ?? "");
          const sanitized = sanitizeThemeCss(rawCss, THEME_CSS_MAX_BYTES, (target) =>
            this.externalThemeAsset(loaded, target),
          );
          if (!sanitized.ok) {
            throw apiError("INVALID_ARGUMENT", sanitized.error);
          }
          const id = pluginThemeId(pluginId, themeId);
          const previous = this.themes.get(id);
          this.themes.set(id, {
            id,
            pluginId,
            themeId,
            label,
            base,
            css: sanitized.css,
            ...(previous?.windowBackground ? { windowBackground: previous.windowBackground } : {}),
          });
          this.services.onPluginThemesChanged?.(pluginId);
          this.services.audit?.({
            pluginId,
            api: "themes.upsert",
            ok: true,
            themeId,
            ts: Date.now(),
          });
        },
        remove: async (themeId: string) => {
          this.assertPermission(loaded, "ui.theme");
          const local = String(themeId ?? "").trim();
          const id = local.startsWith("plugin:") ? local : pluginThemeId(pluginId, local);
          const existing = this.themes.get(id);
          if (!existing || existing.pluginId !== pluginId) {
            throw apiError("NOT_FOUND", `theme not found: ${local}`);
          }
          this.themes.delete(id);
          this.services.onPluginThemesChanged?.(pluginId);
          this.services.audit?.({
            pluginId,
            api: "themes.remove",
            ok: true,
            themeId: existing.themeId,
            ts: Date.now(),
          });
        },
        list: async () => {
          this.assertPermission(loaded, "ui.theme");
          return this.getThemes()
            .filter((theme) => theme.pluginId === pluginId)
            .map((theme) => ({
              id: theme.id,
              themeId: theme.themeId,
              label: theme.label,
              base: theme.base,
            }));
        },
        setVariables: async (themeId: string, values: Record<string, number | string>) => {
          this.assertPermission(loaded, "ui.theme");
          const localThemeId = String(themeId ?? "").replace(`plugin:${pluginId}:`, "");
          const contribution = (loaded.manifest.contributes?.themes ?? []).find(
            (theme) => theme.id === localThemeId,
          );
          if (!contribution) throw apiError("NOT_FOUND", `theme not found: ${themeId}`);
          const declarations = contribution.variables ?? [];
          if (!declarations.length) throw apiError("INVALID_ARGUMENT", "theme declares no runtime variables");
          let patch: Record<string, number | string>;
          try {
            patch = validatePluginThemeVariables(declarations, values);
          } catch (error) {
            throw apiError("INVALID_ARGUMENT", error instanceof Error ? error.message : "invalid theme variables");
          }
          const id = pluginThemeId(pluginId, localThemeId);
          // Read the raw private record here. `plugin.getSettings()` intentionally
          // removes host-reserved state before exposing it to plugin code.
          const settingsFile = join(this.pluginDataDir(pluginId), "settings.json");
          let current: Record<string, unknown> = {};
          try {
            if (existsSync(settingsFile)) current = JSON.parse(readFileSync(settingsFile, "utf8"));
          } catch {
            current = {};
          }
          const existing = current[THEME_VARIABLES_SETTINGS_KEY];
          const stored = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
          const previous = stored[id] && typeof stored[id] === "object" && !Array.isArray(stored[id]) ? stored[id] as Record<string, unknown> : {};
          const next = {
            ...current,
            [THEME_VARIABLES_SETTINGS_KEY]: { ...stored, [id]: { ...previous, ...patch } },
          };
          const dir = this.pluginDataDir(pluginId);
          mkdirSync(dir, { recursive: true });
          writeFileSync(settingsFile, JSON.stringify(next, null, 2), "utf8");
          const registered = this.themes.get(id);
          if (registered) {
            registered.variablesCss = this.themeVariablesCss(loaded, id, declarations);
            this.services.onPluginThemesChanged?.(pluginId);
          }
          this.services.audit?.({ pluginId, api: "themes.setVariables", ok: true, themeId: localThemeId, ts: Date.now() });
        },
      },
      plugin: {
        getId: () => pluginId,
        getManifest: () => loaded.manifest,
        getSettings: async () => {
          const defaults: Record<string, unknown> = {};
          for (const s of loaded.manifest.contributes?.settings ?? []) {
            defaults[s.key] = s.default;
          }
          const file = join(dataPath(), "settings.json");
          if (!existsSync(file)) return defaults;
          try {
            const stored = JSON.parse(readFileSync(file, "utf8"));
            if (stored && typeof stored === "object") delete stored[THEME_VARIABLES_SETTINGS_KEY];
            return { ...defaults, ...stored };
          } catch {
            return defaults;
          }
        },
        setSettings: async (partial: Record<string, unknown>) => {
          const current = await this.hostApi(loaded).plugin.getSettings();
          const next = { ...current, ...partial };
          writeFileSync(join(dataPath(), "settings.json"), JSON.stringify(next, null, 2), "utf8");
        },
        getDataPath: async () => dataPath(),
      },
      ui: {
        openPanel: async (options?: { title?: string }) => {
          this.assertPermission(loaded, "ui.panel");
          const panel = loaded.manifest.ui?.panel;
          if (!panel) throw apiError("NOT_FOUND", "plugin does not declare ui.panel");
          const htmlPath = resolveInsidePlugin(pluginPath, panel);
          if (!htmlPath) {
            throw apiError("INVALID_PARAMS", `panel html must stay inside the plugin: ${panel}`);
          }
          if (!existsSync(htmlPath)) {
            throw apiError("NOT_FOUND", `panel html missing: ${panel}`);
          }
          await this.services.openPanel({
            pluginId,
            title:
              options?.title ||
              resolvePluginLocalizedString(
                loaded.manifest.ui?.title,
                this.services.getLocale?.(),
                loaded.manifest.name,
              ),
            shape: loaded.manifest.ui?.shape,
            alwaysOnTop: loaded.manifest.ui?.alwaysOnTop,
            resizable: loaded.manifest.ui?.resizable,
            width: loaded.manifest.ui?.width ?? 480,
            height: loaded.manifest.ui?.height ?? 360,
            htmlPath,
            netDomains: this.netDomains(loaded),
            allowMicrophone: loaded.permissions.has("ui.microphone"),
            ...(loaded.development ? { development: true } : {}),
          });
          this.services.audit?.({
            pluginId,
            api: "ui.openPanel",
            ok: true,
            ts: Date.now(),
          });
        },
        closePanel: async () => {
          await this.services.closePanel(pluginId);
        },
        showToast: async (message: string, level?: "info" | "warn" | "error") => {
          this.services.showToast(message, level);
        },
        notify: async (input: { title: string; body?: string }) => {
          this.assertPermission(loaded, "notify");
          this.services.notify(input);
        },
        getNotificationPermission: async () => {
          this.assertPermission(loaded, "notify");
          return this.services.getNotificationPermission();
        },
        requestNotificationPermission: async () => {
          this.assertPermission(loaded, "notify");
          return this.services.requestNotificationPermission();
        },
        showNativeNotification: async (input: PluginNativeNotificationInput) => {
          this.assertPermission(loaded, "notify");
          return this.services.showNativeNotification(input);
        },
      },
      workspace: {
        get: async () => {
          // The enriched payload carries the project group behind the visible
          // workspace (ADR 0263); the path-only fallback keeps `get` working for
          // any caller whose services never bound the richer provider.
          const info = this.services.getWorkspaceInfo?.();
          if (info !== undefined) return info;
          const path = this.services.getWorkspacePath();
          if (!path) return null;
          return { path, name: path.split(/[\\/]/).filter(Boolean).at(-1) || path };
        },
      },
      desktop: {
        listOperations: async () => {
          this.assertPermission(loaded, "desktop.control");
          const controller = this.services.desktopControl;
          if (!controller) {
            throw apiError("UNSUPPORTED", "host api not available: desktop.listOperations");
          }
          const operations = controller.operations;
          this.services.audit?.({
            pluginId,
            api: "desktop.listOperations",
            ok: true,
            count: operations.length,
            ts: Date.now(),
          });
          return operations.map(({ id, description, risk }) => ({ id, description, risk }));
        },
        invoke: async (rawInput: unknown) => {
          this.assertPermission(loaded, "desktop.control");
          if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
            throw apiError("INVALID_PARAMS", "desktop.invoke input must be an object");
          }
          const input = rawInput as Record<string, unknown>;
          const operation = typeof input.operation === "string" ? input.operation : "";
          const args = input.args === undefined ? [] : input.args;
          if (!Array.isArray(args)) {
            throw apiError("INVALID_PARAMS", "desktop.invoke args must be an array");
          }
          if (!this.services.desktopControl) {
            throw apiError("UNSUPPORTED", "host api not available: desktop.invoke");
          }
          if (operation === "session/create") {
            const createInput = args[0];
            const inheritedParent =
              createInput && typeof createInput === "object" && !Array.isArray(createInput)
                ? (createInput as Record<string, unknown>).inheritPermissionFromSessionId
                : undefined;
            if (inheritedParent !== undefined && inheritedParent !== null) {
              const callerSessionId = this.inFlightTool(pluginId)?.sessionId?.trim();
              if (
                typeof inheritedParent !== "string" ||
                !callerSessionId ||
                inheritedParent.trim() !== callerSessionId
              ) {
                throw apiError(
                  "PERMISSION_DENIED",
                  "permission inheritance must name the current parent session",
                );
              }
            }
          }
          const operationInfo = this.services.desktopControl.operations.find(
            (candidate) => candidate.id === operation,
          );
          // The controller's `confirm` flag is an acknowledgement by the
          // caller, not a decision by the user. A plugin can set it at will,
          // so a dangerous operation additionally needs the host's native
          // consent; a host without that service refuses outright.
          if (operationInfo?.risk === "dangerous") {
            if (input.confirm !== true) {
              throw apiError(
                "CONFIRMATION_REQUIRED",
                `confirm=true is required for ${operation}`,
              );
            }
            const consent = this.services.confirmDesktopControl;
            const granted = consent
              ? await consent({
                  pluginId,
                  pluginName: resolvePluginLocalizedString(
                    loaded.manifest.name,
                    this.services.getLocale?.(),
                    pluginId,
                  ),
                  operation,
                  description: operationInfo.description,
                  args,
                })
              : false;
            if (!granted) {
              this.services.audit?.({
                pluginId,
                api: "desktop.invoke",
                operation,
                risk: operationInfo.risk,
                ok: false,
                errorCode: "PERMISSION_DENIED",
                ts: Date.now(),
              });
              throw apiError(
                "PERMISSION_DENIED",
                consent
                  ? `user declined ${operation}`
                  : `${operation} needs a user confirmation this host cannot show`,
              );
            }
          }
          try {
            const invocation = this.inFlightTool(pluginId);
            const result = await this.services.desktopControl.invoke({
              operation,
              args,
              confirm: input.confirm === true,
              source: "plugin",
              pluginContext: {
                pluginId,
                ...(invocation?.sessionId ? { sessionId: invocation.sessionId } : {}),
                ...(invocation?.turnId ? { turnId: invocation.turnId } : {}),
                ...(invocation ? { invocationId: invocation.id } : {}),
              },
              ...(invocation ? { signal: invocation.signal } : {}),
            } satisfies McpControlInvokeInput);
            this.services.audit?.({
              pluginId,
              api: "desktop.invoke",
              operation,
              risk: operationInfo?.risk,
              ok: true,
              ts: Date.now(),
            });
            return result;
          } catch (error) {
            this.services.audit?.({
              pluginId,
              api: "desktop.invoke",
              operation,
              risk: operationInfo?.risk,
              ok: false,
              errorCode: (error as { code?: unknown })?.code,
              ts: Date.now(),
            });
            throw error;
          }
        },
      },
      fs: {
        readText: async (pathFromRoot: string) => {
          const { full, rel } = await this.resolveFsRequest(
            loaded,
            "read",
            pathFromRoot,
          );
          const content = readFileSync(full, "utf8");
          this.services.audit?.({
            pluginId,
            api: "fs.readText",
            ok: true,
            ts: Date.now(),
            path: rel,
          });
          return content;
        },
        stat: async (pathFromRoot: string, grantId?: string) => {
          const { full, rel } = await this.resolveFsRequest(loaded, "read", pathFromRoot, {
            dropGrantId: grantId,
          });
          let info: ReturnType<typeof statSync>;
          try {
            info = statSync(full);
          } catch (error) {
            this.auditFs(loaded, "read", rel, "NOT_FOUND");
            throw apiError("NOT_FOUND", error instanceof Error ? error.message : String(error));
          }
          if (!info.isFile()) {
            this.auditFs(loaded, "read", rel, "INVALID_ARGUMENT");
            throw apiError("INVALID_ARGUMENT", "only files can be stated");
          }
          this.services.audit?.({
            pluginId,
            api: "fs.stat",
            ok: true,
            ts: Date.now(),
            path: rel,
          });
          return { size: info.size, mtimeMs: info.mtimeMs };
        },
        readRange: async (
          pathFromRoot: string,
          byteOffset: number,
          length: number,
          grantId?: string,
        ) => {
          const { full, rel } = await this.resolveFsRequest(loaded, "read", pathFromRoot, {
            dropGrantId: grantId,
          });
          if (
            !Number.isSafeInteger(byteOffset) ||
            byteOffset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > MAX_FS_READ_RANGE_BYTES
          ) {
            this.auditFs(loaded, "read", rel, "INVALID_ARGUMENT");
            throw apiError(
              "INVALID_ARGUMENT",
              `byte range must be a non-negative offset and a length up to ${MAX_FS_READ_RANGE_BYTES} bytes`,
            );
          }
          const info = statSync(full);
          if (!info.isFile()) {
            this.auditFs(loaded, "read", rel, "INVALID_ARGUMENT");
            throw apiError("INVALID_ARGUMENT", "only files can be read by range");
          }
          const handle = await openFile(full, "r");
          try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, byteOffset);
            this.services.audit?.({
              pluginId,
              api: "fs.readRange",
              ok: true,
              ts: Date.now(),
              path: rel,
              data: { byteOffset, length: bytesRead, totalSize: info.size },
            });
            return {
              bytes: Uint8Array.from(buffer.subarray(0, bytesRead)),
              totalSize: info.size,
            };
          } finally {
            await handle.close().catch(() => {});
          }
        },
        readPreview: async (pathFromRoot: string) => {
          const { full, rel } = await this.resolveFsRequest(
            loaded,
            "read",
            pathFromRoot,
          );
          if (!statSync(full).isFile()) {
            this.services.audit?.({
              pluginId,
              api: "fs.readPreview",
              ok: false,
              errorCode: "INVALID_ARGUMENT",
              ts: Date.now(),
              path: rel,
            });
            throw apiError("INVALID_ARGUMENT", "only files can be previewed");
          }
          const preview = await previewFile(full, rel);
          this.services.audit?.({
            pluginId,
            api: "fs.readPreview",
            ok: true,
            ts: Date.now(),
            path: rel,
            data: { kind: preview.kind, size: preview.size },
          });
          return preview;
        },
        openDefault: async (pathFromRoot: string) => {
          const { full, rel } =
            (await this.resolveRegisteredFolderRequest(loaded, pathFromRoot)) ??
            (await this.resolveFsRequest(loaded, "read", pathFromRoot));
          if (!statSync(full).isFile()) {
            this.services.audit?.({
              pluginId,
              api: "fs.openDefault",
              ok: false,
              errorCode: "INVALID_ARGUMENT",
              ts: Date.now(),
              path: rel,
            });
            throw apiError("INVALID_ARGUMENT", "only files can be opened with the default app");
          }
          try {
            await this.services.openPath(full);
          } catch (error) {
            this.services.audit?.({
              pluginId,
              api: "fs.openDefault",
              ok: false,
              errorCode: "OPEN_FAILED",
              ts: Date.now(),
              path: rel,
            });
            throw apiError("OPEN_FAILED", error instanceof Error ? error.message : String(error));
          }
          this.services.audit?.({
            pluginId,
            api: "fs.openDefault",
            ok: true,
            ts: Date.now(),
            path: rel,
          });
        },
        reveal: async (pathFromRoot: string) => {
          const { full, rel } =
            (await this.resolveRegisteredFolderRequest(loaded, pathFromRoot)) ??
            (await this.resolveFsRequest(loaded, "read", pathFromRoot));
          if (!statSync(full).isFile()) {
            this.services.audit?.({
              pluginId,
              api: "fs.reveal",
              ok: false,
              errorCode: "INVALID_ARGUMENT",
              ts: Date.now(),
              path: rel,
            });
            throw apiError("INVALID_ARGUMENT", "only files can be revealed in the file manager");
          }
          if (!this.services.revealPath) {
            this.services.audit?.({
              pluginId,
              api: "fs.reveal",
              ok: false,
              errorCode: "UNSUPPORTED",
              ts: Date.now(),
              path: rel,
            });
            throw apiError("UNSUPPORTED", "revealPath service missing");
          }
          try {
            await this.services.revealPath(full);
          } catch (error) {
            this.services.audit?.({
              pluginId,
              api: "fs.reveal",
              ok: false,
              errorCode: "REVEAL_FAILED",
              ts: Date.now(),
              path: rel,
            });
            throw apiError("REVEAL_FAILED", error instanceof Error ? error.message : String(error));
          }
          this.services.audit?.({
            pluginId,
            api: "fs.reveal",
            ok: true,
            ts: Date.now(),
            path: rel,
          });
        },
        /**
         * One directory's entries, so a plugin can walk a tree lazily instead
         * of pulling a whole-repo glob it then has to reassemble.
         *
         * The guards match `fs.glob` exactly — declared read scope, protected
         * paths, denied names, skipped heavy directories — because a listing is
         * a read: what a plugin may not open, it may not learn the name of.
         */
        list: async (pathFromRoot: string) => {
          this.assertPermission(loaded, "fs.read");
          const rule = loaded.fsPolicy.read ?? { root: "workspace", scope: [] };
          const root = this.fsRoot(loaded, rule);
          if (!root) throw apiError("NOT_FOUND", "No workspace is open");
          const rel = normalizeFsPath(String(pathFromRoot ?? ""));
          if (rel.split("/").includes("..")) {
            throw apiError("INVALID_ARGUMENT", "path must stay inside the root");
          }
          const base = realpathOrSelf(root);
          const dir = rel ? join(base, rel) : base;
          if (this.isProtectedPath(dir)) {
            throw apiError("PERMISSION_DENIED", "path is protected");
          }
          let names: string[] = [];
          try {
            names = readdirSync(dir);
          } catch {
            throw apiError("NOT_FOUND", `cannot list ${rel || "."}`);
          }
          const entries: Array<{
            name: string;
            path: string;
            isDirectory: boolean;
            size?: number;
            mtimeMs?: number;
          }> = [];
          for (const name of names.sort()) {
            if (entries.length >= MAX_LIST_ENTRIES) break;
            const childRel = rel ? `${rel}/${name}` : name;
            const full = join(dir, name);
            if (isDeniedFsPath(childRel)) continue;
            if (this.isProtectedPath(full)) continue;
            let st: ReturnType<typeof statSync>;
            try {
              st = statSync(full);
            } catch {
              continue;
            }
            if (st.isDirectory()) {
              if (GLOB_SKIP_DIRS.has(name)) continue;
              // A directory is offered whenever anything under it could be in
              // scope, so a narrow scope still yields a navigable tree.
              entries.push({ name, path: childRel, isDirectory: true });
              continue;
            }
            if (rule.root !== "userSelected" && !isFsPathInScope(childRel, rule.scope)) {
              continue;
            }
            entries.push({
              name,
              path: childRel,
              isDirectory: false,
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          }
          this.services.audit?.({
            pluginId,
            api: "fs.list",
            ok: true,
            ts: Date.now(),
            path: rel,
            data: { entries: entries.length },
          });
          return entries;
        },
        writeText: async (pathFromRoot: string, content: string) => {
          const { full, rel } = await this.resolveFsRequest(
            loaded,
            "write",
            pathFromRoot,
            { create: true },
          );
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content, "utf8");
          // Recorded so `fs.delete` with `own` can clean up this file later
          // without asking: removing your own output surprises nobody.
          this.recordWrite(loaded, full);
          this.services.audit?.({
            pluginId,
            api: "fs.writeText",
            ok: true,
            ts: Date.now(),
            path: rel,
          });
        },
        glob: async (pattern: string) => {
          this.assertPermission(loaded, "fs.read");
          const rule = loaded.fsPolicy.read ?? { root: "workspace", scope: [] };
          const root = this.fsRoot(loaded, rule);
          if (!root) throw apiError("NOT_FOUND", "No workspace is open");
          const matches: string[] = [];
          const visit = (dir: string, rel = "") => {
            if (matches.length >= MAX_GLOB_MATCHES) return;
            let entries: string[] = [];
            try {
              entries = readdirSync(dir);
            } catch {
              return;
            }
            for (const entry of entries) {
              if (matches.length >= MAX_GLOB_MATCHES) return;
              const full = join(dir, entry);
              const nextRel = rel ? `${rel}/${entry}` : entry;
              let st: ReturnType<typeof statSync>;
              try {
                st = statSync(full);
              } catch {
                continue;
              }
              if (st.isDirectory()) {
                // Skipped rather than filtered: walking a node_modules tree to
                // discard every hit is the slow way to return nothing.
                if (GLOB_SKIP_DIRS.has(entry)) continue;
                if (this.isProtectedPath(full)) continue;
                visit(full, nextRel);
                continue;
              }
              if (!matchFsGlob(nextRel, pattern)) continue;
              if (isDeniedFsPath(nextRel)) continue;
              // A name is a read too: what the plugin may not open, it may not
              // learn the existence of.
              if (this.isProtectedPath(full)) continue;
              // A listing is a read: what the plugin may not open, it may not
              // learn the name of either.
              if (rule.root !== "userSelected" && !isFsPathInScope(nextRel, rule.scope)) {
                continue;
              }
              matches.push(nextRel);
            }
          };
          visit(realpathOrSelf(root));
          this.services.audit?.({
            pluginId,
            api: "fs.glob",
            ok: true,
            ts: Date.now(),
            data: { pattern, matches: matches.length },
          });
          return matches;
        },
        remove: async (pathFromRoot: string) => {
          const { full, rel, root } = await this.resolveFsRequest(
            loaded,
            "delete",
            pathFromRoot,
          );
          if (full === resolve(root)) {
            throw apiError("INVALID_ARGUMENT", "cannot remove the root itself");
          }
          if (!existsSync(full)) {
            throw apiError("NOT_FOUND", `path not found: ${pathFromRoot}`);
          }
          // Scope answers "may this file go"; the brake answers "this many, this
          // fast?", which is the only thing that separates a cleanup from a wipe.
          if (this.deleteRateExceeded(loaded)) {
            await this.requestFsConsent(loaded, "delete", rel, full, "rate");
            loaded.deletes = [];
          }
          // Never recurse: removing a file or an empty directory is in scope,
          // but a non-empty directory has to fail closed.
          if (this.services.trashItem) {
            // The OS trash is the undo. Nothing of the user's is copied
            // anywhere, and a delete this gate got wrong stays recoverable.
            if (statSync(full).isDirectory() && readdirSync(full).length) {
              throw apiError("INVALID_ARGUMENT", "refusing to remove a non-empty directory");
            }
            await this.services.trashItem(full);
          } else {
            rmSync(full, { recursive: false, force: false });
          }
          this.services.audit?.({
            pluginId,
            api: "fs.remove",
            ok: true,
            ts: Date.now(),
            path: rel,
          });
        },
        requestDirectory: async () => {
          this.assertPermission(loaded, "fs.read");
          const picker = this.services.pickDirectory;
          if (!picker) throw apiError("UNSUPPORTED", "no directory picker is available");
          const picked = await picker({ pluginId, pluginName: loaded.manifest.name });
          if (!picked) {
            this.services.audit?.({
              pluginId,
              api: "fs.requestDirectory",
              ok: false,
              errorCode: "CANCELLED",
              ts: Date.now(),
            });
            return null;
          }
          // Replaces any earlier pick: one root at a time keeps what the plugin
          // can reach the same thing the user last pointed at.
          loaded.userRoot = resolve(picked);
          this.services.audit?.({
            pluginId,
            api: "fs.requestDirectory",
            ok: true,
            ts: Date.now(),
            path: loaded.userRoot,
          });
          return { path: loaded.userRoot, name: basename(loaded.userRoot) };
        },
      },
      clipboard: {
        readText: async () => {
          this.assertPermission(loaded, "clipboard.read");
          const text = await this.services.readClipboard();
          this.services.audit?.({
            pluginId,
            api: "clipboard.readText",
            ok: true,
            ts: Date.now(),
          });
          return text;
        },
        writeText: async (text: string) => {
          this.assertPermission(loaded, "clipboard.write");
          await this.services.writeClipboard(text);
          this.services.audit?.({
            pluginId,
            api: "clipboard.writeText",
            ok: true,
            ts: Date.now(),
          });
        },
        getHistory: async () => {
          this.assertPermission(loaded, "clipboard.read");
          try {
            const history = await this.services.readClipboardHistory();
            this.services.audit?.({
              pluginId,
              api: "clipboard.getHistory",
              ok: true,
              entryCount: history.length,
              ts: Date.now(),
            });
            return history;
          } catch (error) {
            this.services.audit?.({
              pluginId,
              api: "clipboard.getHistory",
              ok: false,
              errorCode: (error as PluginApiError).code ?? "INTERNAL",
              ts: Date.now(),
            });
            throw error;
          }
        },
      },
      shell: {
        openExternal: async (url: string) => {
          this.assertPermission(loaded, "shell.openExternal");
          const allowed = parseAllowedExternalUrl(url);
          if (!allowed) {
            throw apiError("INVALID_ARGUMENT", "only http(s)/mailto URLs allowed");
          }
          await this.services.openExternal(allowed);
          this.services.audit?.({
            pluginId,
            api: "shell.openExternal",
            ok: true,
            ts: Date.now(),
            url,
          });
        },
      },
      /**
       * Background audio is declared, gated, and not implemented: the host has
       * no device backend yet, so every call runs the permission gate and then
       * answers with a coded `UNSUPPORTED`. That is the contract a plugin can
       * branch on — without it a call would fail as a bare `TypeError` with no
       * `code` at all, and nothing would reach the audit log.
       */
      audio: {
        getInputDevices: async () => this.refuseAudio(loaded, "audio.getInputDevices"),
        openInput: async () => this.refuseAudio(loaded, "audio.openInput"),
        closeInput: async () => this.refuseAudio(loaded, "audio.closeInput"),
        getCaptureState: async () => this.refuseAudio(loaded, "audio.getCaptureState"),
        onInputFrame: async () => this.refuseAudio(loaded, "audio.onInputFrame"),
        offInputFrame: async () => this.refuseAudio(loaded, "audio.offInputFrame"),
        openOutput: async () => this.refuseAudio(loaded, "audio.openOutput"),
        writeOutput: async () => this.refuseAudio(loaded, "audio.writeOutput"),
        stopOutput: async () => this.refuseAudio(loaded, "audio.stopOutput"),
        closeOutput: async () => this.refuseAudio(loaded, "audio.closeOutput"),
      },
      net: {
        fetch: async (input: {
          url: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
          timeoutMs?: number;
        }) => {
          this.assertPermission(loaded, "net.fetch");
          if (!/^https?:\/\//i.test(input.url)) {
            throw apiError("INVALID_ARGUMENT", "only http(s) URLs allowed");
          }
          this.assertEgress(loaded, input.url, "net.fetch");
          if (this.services.fetch) {
            const result = await this.services.fetch(input);
            this.services.audit?.(
              netFetchAuditEntry(pluginId, input.url, result.status, result.headers),
            );
            return result;
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15000);
          try {
            // Follow redirects by hand: an allowlisted host that 30x-es to an
            // undeclared one would otherwise carry the request straight out.
            let url = input.url;
            let res: Response;
            for (let hop = 0; ; hop += 1) {
              res = await fetch(url, {
                method: input.method ?? "GET",
                headers: input.headers,
                body: input.body,
                redirect: "manual",
                signal: controller.signal,
              });
              if (res.status < 300 || res.status > 399) break;
              const location = res.headers.get("location");
              if (!location) break;
              if (hop >= NET_FETCH_MAX_REDIRECTS) {
                throw apiError("UNAVAILABLE", `too many redirects: ${input.url}`);
              }
              url = new URL(location, url).toString();
              this.assertEgress(loaded, url, "net.fetch");
            }
            const headers: Record<string, string> = {};
            res.headers.forEach((value, key) => {
              headers[key] = value;
            });
            const bodyText = await res.text();
            this.services.audit?.(netFetchAuditEntry(pluginId, url, res.status, headers));
            return { status: res.status, headers, bodyText };
          } finally {
            clearTimeout(timer);
          }
        },
      },
      bus: {
        publish: async (topic: string, payload?: unknown) => this.busPublish(loaded, topic, payload),
        subscribe: async (pattern: string) => this.busSubscribe(loaded, pattern),
        unsubscribe: async (subscriptionId: string) =>
          this.busUnsubscribe(loaded, subscriptionId),
      },
      browser: {
        navigate: async (input: { url?: string; path?: string } = {}) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const result = await this.services.browser.navigate(
            input,
            this.browserSessionId(pluginId),
          );
          this.services.audit?.({
            pluginId,
            api: "browser.navigate",
            ok: true,
            ts: Date.now(),
          });
          return result;
        },
        action: (input: "back" | "forward" | "reload" | "stop" | { action?: string }) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const action = typeof input === "string" ? input : String(input?.action ?? "");
          if (
            action === "back" ||
            action === "forward" ||
            action === "reload" ||
            action === "stop"
          ) {
            this.services.browser.action(action);
          }
        },
        setBounds: (hole: unknown) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          return this.services.browser.setBounds(pluginId, hole);
        },
        setVisible: (input: boolean | { visible?: boolean }) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const visible = typeof input === "boolean" ? input : input?.visible === true;
          this.services.browser.setVisible(pluginId, visible);
        },
        getState: () => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          return this.services.browser.getState();
        },
        openExternal: () => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          this.services.browser.openExternal();
          this.services.audit?.({
            pluginId,
            api: "browser.openExternal",
            ok: true,
            ts: Date.now(),
          });
        },
        snapshot: async () => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          return this.services.browser.snapshot();
        },
        screenshot: async (input?: { fullPage?: boolean }) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          return this.services.browser.screenshot(
            input,
            this.browserSessionId(pluginId),
          );
        },
        click: async (input: string | { uid?: string }) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const uid = typeof input === "string" ? input : String(input?.uid ?? "");
          await this.services.browser.click(uid);
        },
        fill: async (
          input: string | { uid?: string; text?: string },
          textArg?: string,
        ) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const uid = typeof input === "string" ? input : String(input?.uid ?? "");
          const text = typeof input === "string" ? String(textArg ?? "") : String(input?.text ?? "");
          await this.services.browser.fill(uid, text);
        },
        evaluate: async (input: string | { expression?: string }) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const expression = typeof input === "string" ? input : String(input?.expression ?? "");
          this.services.audit?.({
            pluginId,
            api: "browser.evaluate",
            ok: true,
            ts: Date.now(),
          });
          return this.services.browser.evaluate(expression);
        },
        console: (input?: number | { limit?: number }) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const limit = typeof input === "number" ? input : input?.limit;
          return this.services.browser.console(limit);
        },
        cdp: async (
          input: string | { method?: string; params?: unknown },
          paramsArg?: unknown,
        ) => {
          this.assertPermission(loaded, "browser.cdp");
          if (!this.services.browser) {
            throw apiError("UNAVAILABLE", "browser host missing");
          }
          const method = typeof input === "string" ? input : String(input?.method ?? "");
          const params = typeof input === "string" ? paramsArg : input?.params;
          this.services.audit?.({
            pluginId,
            api: "browser.cdp",
            ok: true,
            ts: Date.now(),
            method,
          });
          return this.services.browser.cdp(method, params);
        },
      },
    };
  }
}

/**
 * Which audio permission each declared method belongs to. Capture and playback
 * are separate grants, so a playback-only plugin must not be told that a
 * capture method exists.
 */
const AUDIO_PLAYBACK_APIS = new Set([
  "audio.openOutput",
  "audio.writeOutput",
  "audio.stopOutput",
  "audio.closeOutput",
]);
