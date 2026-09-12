import { isValidBusTopic, isValidBusTopicPattern } from "./bus-topics.js";
import {
  parseFsPolicy,
  resolveFsAccess,
  PLUGIN_FS_MODES,
  type PluginFsPolicy,
} from "./fs-policy.js";
import { validateMcpServer } from "./mcp-config.js";
import { parseNetDomains, type PluginNetDomain } from "./net-policy.js";

/**
 * Manifest id shape frozen by docs/spec/07-plugins/02-plugin-manifest-schema.md:
 * a lowercase dotted namespace such as `demo.hello` or `pi.browser`.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;

/** `author` may be a display string or a contact object (manifest schema §2). */
export type PluginManifestAuthor =
  | string
  | { name: string; email?: string; url?: string };

export type PluginManifest = {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: PluginManifestAuthor;
  homepage?: string;
  repository?: string;
  main: string;
  icon?: string;
  /**
   * First-registration default for bundled plugins. Omitted means enabled.
   * Marketplace and development installs still enable after the user grants
   * permissions.
   */
  enabledByDefault?: boolean;
  ui?: {
    panel?: string;
    width?: number;
    height?: number;
    title?: PluginLocalizedString | string;
  };
  contributes?: {
    commands?: Array<{
      id: string;
      title: string;
      keywords?: string[];
      category?: string;
    }>;
    agentTools?: Array<{
      name: string;
      description: string;
      risk?: "low" | "medium" | "high";
      /**
       * Action names that may run in Plan or Goal mode. Omitted or empty
       * means the tool is hidden from the model in those modes (ADR 0211).
       * Only meaningful when the schema has an `action` enum and every
       * entry is a value of that enum; the host enforces the restriction
       * even if a plugin mis-declares, so misuse is caught at execute time.
       */
      planSafeActions?: readonly string[];
      schema?: unknown;
    }>;
    /** Relative skill paths, or entries that override the parsed metadata. */
    skills?: Array<string | PluginSkillContrib>;
    /**
     * ExtensionAPI modules (the pi CLI extension contract) that run inside the
     * agent process with the agent's own access. Requires the
     * `agent.extension` permission; each path is a `.ts` / `.js` file inside
     * the plugin directory (spec 07-plugins/16).
     */
    agentExtensions?: string[];
    settings?: PluginSettingContrib[];
    themes?: PluginThemeContrib[];
    mcpServers?: PluginMcpServerContrib[];
    services?: PluginServiceContrib[];
    bus?: PluginBusContrib;
    /** Surfaces the plugin docks inside the host's work panel. */
    views?: PluginViewContrib[];
    /** External session namespaces this plugin may import and own. */
    sessionSources?: PluginSessionSourceContrib[];
  };
  permissions?: string[];
  /**
   * File scope. The `fs.read` / `fs.write` / `fs.delete` permissions say
   * whether the plugin may touch files; this says which ones. Anything outside
   * the declared scope falls to the user at call time, so an omitted block is
   * safe rather than broad.
   */
  fs?: PluginFsPolicy;
  /**
   * Egress allowlist. Every outbound path the host owns — the panel session,
   * `pi.net.fetch`, remote MCP endpoints — is confined to these hostnames.
   * Omitted or empty means no egress, whatever `net.fetch` says.
   */
  net?: { domains?: PluginNetDomain[] };
  engines?: { piDesktop?: string };
  activationEvents?: string[];
};

/** A plugin-provided label. Shell UI may add locales; plugins still ship en + zh-CN. */
export type PluginLocalizedString = {
  en: string;
  "zh-CN": string;
};

export type PluginSessionSourceContrib = {
  id: string;
  label?: string | PluginLocalizedString;
};

export type PluginSessionMessage =
  | { role: "user"; content: string; createdAt: string }
  | {
      role: "assistant";
      content: string;
      createdAt: string;
      modelId?: string;
      providerId?: string;
    }
  | {
      role: "tool";
      content: string;
      createdAt: string;
      toolName: string;
      toolCallId: string;
      toolStatus: "success" | "error";
      toolArgs?: unknown;
      toolResult?: unknown;
    };

export type PluginSessionImportInput = {
  source: string;
  externalId: string;
  title: string;
  /** Explicit host project created through `pi.project.create`; omitted stays unbound. */
  projectId?: number | null;
  projectPath?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  createdAt: string;
  updatedAt: string;
  messages: PluginSessionMessage[];
};

export type PluginSessionImportResult = {
  sessionId: string;
  imported: boolean;
  skipped: boolean;
};

export type PluginSessionBatchImportInput = {
  source: string;
  sessions: Array<Omit<PluginSessionImportInput, "source">>;
  mode?: "skip" | "fail";
};

export type PluginSessionBatchImportResult = {
  results: Array<{
    externalId: string;
    sessionId: string | null;
    status: "imported" | "skipped" | "failed";
    errorCode?: string;
    errorMessage?: string;
  }>;
  imported: number;
  skipped: number;
  failed: number;
};

export type PluginProjectRecord = {
  projectId: number;
  path: string;
  name: string;
};

export type PluginSessionListItem = {
  sessionId: string;
  title: string;
  source: string;
  externalId: string;
  projectId: number | null;
  messageCount: number;
  originKind: "imported" | "created";
  bound: { workspace: boolean; model: boolean };
  createdAt: string;
  updatedAt: string;
};

export type PluginSessionListResult = {
  items: PluginSessionListItem[];
  nextCursor?: string;
};

export type PluginSessionGetResult = {
  sessionId: string;
  title: string;
  source: string;
  externalId: string;
  originKind: "imported" | "created";
  projectId: number | null;
  projectPath: string | null;
  modelId: string | null;
  providerId: string | null;
  history: {
    projectPath: string | null;
    modelId: string | null;
    providerId: string | null;
  };
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PluginSessionMessageResult = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  contentTruncated?: boolean;
  createdAt: string;
  origin: "external";
  tool?: {
    name: string;
    callId: string;
    status: "success" | "error";
    args?: unknown;
    result?: unknown;
  };
};

export type PluginSessionMessageListResult = {
  items: PluginSessionMessageResult[];
  nextCursor?: string;
};

/** Resolve a plugin label using the active PI-Desktop locale. */
export function resolvePluginLocalizedString(
  value: string | PluginLocalizedString | undefined,
  locale: string | undefined,
  fallback = "",
): string {
  if (typeof value === "string") return value || fallback;
  if (!value) return fallback;
  const normalized = locale?.replaceAll("_", "-").toLowerCase();
  const simplifiedChinese =
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized?.startsWith("zh-cn-") ||
    normalized === "zh-hans" ||
    normalized?.startsWith("zh-hans-") ||
    normalized === "zh-sg" ||
    normalized?.startsWith("zh-sg-");
  const preferred = simplifiedChinese ? value["zh-CN"] : value.en;
  return preferred || value.en || value["zh-CN"] || fallback;
}

export type PluginSettingType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "json"
  | "shortcut";

export type PluginSettingOption = {
  label: string;
  value: string | number | boolean;
};

export type PluginSettingContrib = {
  key: string;
  title: string;
  description?: string;
  type: PluginSettingType;
  default?: unknown;
  enum?: PluginSettingOption[];
  /** Recognized so the validator can reject secrets until secure storage exists. */
  secret?: boolean;
  /** Shortcut settings invoke this command in the current app window. */
  command?: string;
  /** Reserved for the future; only plugin-local shortcuts are accepted today. */
  scope?: "plugin";
};

export type PluginSkillContrib = {
  /** Plugin-local skill id. Defaults to the file name without its extension. */
  id?: string;
  /** Relative path to the skill document. */
  path: string;
  /** Overrides the `name` parsed from the document front matter. */
  name?: string;
  /** Overrides the `description` parsed from the document front matter. */
  description?: string;
};

export type PluginThemeContrib = {
  id: string;
  label: string;
  /** Relative path to a `.css` file contributed by the plugin. */
  path: string;
  /** Base palette the overrides are layered on. Defaults to `dark`. */
  base?: "light" | "dark";
};

export type PluginMcpServerContrib = {
  id: string;
  label?: string;
  transport: "stdio" | "http";
  /** stdio only: bare PATH name or plugin-relative executable. */
  command?: string;
  args?: string[];
  /** stdio only: literal values, or `{ "setting": "<key>" }` to read plugin settings. */
  env?: Record<string, string | { setting: string }>;
  /** http only: an absolute `http://` or `https://` endpoint. */
  url?: string;
  headers?: Record<string, string | { setting: string }>;
};

export type PluginServiceContrib = {
  id: string;
  label?: string;
  /** Restart the plugin process when it exits unexpectedly. Defaults to true. */
  autoRestart?: boolean;
};

export type PluginBusContrib = {
  /** Topics this plugin may publish to. */
  publish?: string[];
  /** Topic patterns this plugin may subscribe to. */
  subscribe?: string[];
};

/**
 * Icon tokens a docked view may name.
 *
 * Deliberately a closed set drawn from the host's own icon library rather than
 * a plugin-supplied SVG: the icon is rendered inside the host's chrome, next to
 * first-party controls, so accepting plugin markup there would add an injection
 * surface and let a plugin impersonate host UI for nothing gained. An unknown
 * token is not an error — the host falls back to a lettered tile — so this list
 * can grow without invalidating installed plugins.
 */
export const PLUGIN_VIEW_ICONS = [
  "bell",
  "book",
  "bot",
  "branch",
  "browser",
  "chat",
  "clock",
  "diff",
  "files",
  "folder",
  "image",
  "key",
  "link",
  "list-checks",
  "palette",
  "plug",
  "pull-request",
  "search",
  "server",
  "shield",
  "sparkles",
  "target",
  "terminal",
  "workflow",
  "wrench",
] as const;

export type PluginViewIcon = (typeof PLUGIN_VIEW_ICONS)[number];

/**
 * One surface the plugin docks inside the host's work panel.
 *
 * A view is the same isolated web page as `ui.panel`, rendered in the panel
 * column instead of a separate window. A plugin may declare several: a Git
 * plugin can ship "Changes" and "History" as two independent entries.
 */
export type PluginViewContrib = {
  /** Plugin-local view id; `<pluginId>/<id>` addresses it globally. */
  id: string;
  /** Menu label. Localized objects are resolved against the host locale. */
  title: PluginLocalizedString | string;
  /** Token from `PLUGIN_VIEW_ICONS`; anything else renders as a letter tile. */
  icon?: string;
  /** Relative path to the view's HTML entry. */
  entry: string;
  /** Ascending sort key within the plugin-views menu group. Defaults to 0. */
  order?: number;
};

export type PluginCommand = {
  id: string;
  title: string;
  keywords?: string[];
  category?: string;
  run: () => Promise<void> | void;
};

export type PluginTool = {
  name: string;
  description: string;
  risk?: "low" | "medium" | "high";
  /**
   * Action names that may run in Plan or Goal mode. Omitted or empty
   * means the tool is hidden from the model in those modes (ADR 0211).
   * Only meaningful when the schema has an `action` enum and every
   * entry is a value of that enum; the host enforces the restriction
   * even if a plugin mis-declares, so misuse is caught at execute time.
   */
  planSafeActions?: readonly string[];
  schema?: unknown;
  execute: (args: unknown, ctx?: PluginToolExecContext) => Promise<unknown> | unknown;
};

export type PluginToolExecContext = {
  sessionId?: string;
  turnId?: string;
  /** Durable session operating mode. Host-core is authoritative (ADR 0211). */
  mode?: "agent" | "plan" | "goal";
  /** Executor model for this session, `providerId/modelId`. Configuration, not transcript. */
  modelKey?: string;
  thinkingLevel?: string;
  signal?: AbortSignal;
  log: (msg: string) => void;
};

export type PluginModelInfo = {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  label: string;
  supportsReasoning: boolean;
  thinkingLevels: string[];
};

export type PluginLlmMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
};

export type PluginLlmContext = {
  sessionId: string;
  modelKey: string | null;
  thinkingLevel?: string;
  messages: PluginLlmMessage[];
  truncated: boolean;
};

export type PluginCompleteInput = {
  modelKey: string;
  thinkingLevel?: string;
  system?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  includeSessionContext?: boolean;
};

export type PluginCompleteResult = {
  text: string;
  modelKey: string;
  thinkingLevel?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type PluginServiceContext = {
  /** Appends a line to the plugin's host log. */
  log: (msg: string) => void;
};

export type PluginService = {
  /** Must match a `contributes.services[].id` entry. */
  id: string;
  start: (ctx: PluginServiceContext) => Promise<void> | void;
  stop?: () => Promise<void> | void;
};

export type PluginBusMessage = {
  topic: string;
  /** Plugin id of the publisher. */
  from: string;
  payload?: unknown;
  /** ISO timestamp assigned by the host. */
  at: string;
};

export type PluginNotificationPermission =
  | "granted"
  | "denied"
  | "unknown"
  | "unsupported";

export type PluginNativeNotificationInput = {
  title: string;
  body?: string;
};

export type PluginNativeNotificationResult = {
  shown: boolean;
  permission: PluginNotificationPermission;
};

export type ClipboardHistoryEntry =
  | {
      type: "text";
      text: string;
      capturedAt: string;
    }
  | {
      type: "image";
      format: "png" | "jpeg" | "webp";
      data: Uint8Array;
      width: number;
      height: number;
      capturedAt: string;
    };

/** One entry returned by `fs.list`, relative to the rule's root. */
export type PluginFsEntry = {
  name: string;
  /** Root-relative path, usable directly with `fs.readText` / `fs.list`. */
  path: string;
  isDirectory: boolean;
  /** Files only. */
  size?: number;
  /** Files only; milliseconds since the Unix epoch. */
  mtimeMs?: number;
};

export type PluginFsStat = {
  size: number;
  mtimeMs: number;
};

export type PluginFsRange = {
  bytes: Uint8Array;
  totalSize: number;
};

export type PluginDesktopOperation = {
  id: string;
  description: string;
  risk: "read" | "write" | "dangerous";
};

export type PluginDesktopInvokeInput = {
  operation: string;
  args?: unknown[];
  confirm?: boolean;
};

/** Classified preview returned by `fs.readPreview`. */
export type PluginFsPreview = {
  kind: "text" | "image" | "binary" | "tooLarge";
  /** UTF-8 file content when kind is `"text"`. */
  content?: string;
  /** Base64 data URL when kind is `"image"`. */
  dataUrl?: string;
  size: number;
};

/**
 * The appearance the host is currently showing. Mirrors `PluginAppearance` in
 * the desktop's plugin panel chrome; keep the two shapes identical.
 */
export type PluginAppearance = {
  /** Raw preference: "light" | "dark" | "system" | "plugin:<pluginId>:<themeId>". */
  theme: string;
  /** Resolved palette: "light" | "dark", or "system" when unresolved. */
  base: "light" | "dark" | "system";
  /** Active app language tag (e.g. "en", "zh-CN"). */
  locale: string;
  /** The active contributed theme, when the preference selects one. */
  pluginTheme: { id: string; base: "light" | "dark"; css: string } | null;
};

export type PluginHostApi = {
  app: {
    getVersion: () => Promise<string>;
    getLocale: () => Promise<string>;
    getAppearance: () => Promise<PluginAppearance>;
  };
  plugin: {
    getId: () => string;
    getManifest: () => PluginManifest;
    getSettings: () => Promise<Record<string, unknown>>;
    setSettings: (partial: Record<string, unknown>) => Promise<void>;
    getDataPath: () => Promise<string>;
  };
  commands: {
    register: (command: PluginCommand) => Promise<void>;
    unregister: (id: string) => Promise<void>;
  };
  ui: {
    openPanel: (opts?: { title?: string }) => Promise<void>;
    closePanel: () => Promise<void>;
    showToast: (message: string, level?: "info" | "warn" | "error") => Promise<void>;
    notify: (input: { title: string; body?: string }) => Promise<void>;
    getNotificationPermission: () => Promise<PluginNotificationPermission>;
    requestNotificationPermission: () => Promise<PluginNotificationPermission>;
    showNativeNotification: (
      input: PluginNativeNotificationInput,
    ) => Promise<PluginNativeNotificationResult>;
  };
  project: {
    create: (input: { path: string }) => Promise<PluginProjectRecord>;
  };
  workspace: {
    get: () => Promise<{ path: string; name: string } | null>;
  };
  /** Reviewed host operations shared with the local MCP control plane. */
  desktop: {
    listOperations: () => Promise<PluginDesktopOperation[]>;
    invoke: (input: PluginDesktopInvokeInput) => Promise<unknown>;
  };
  /**
   * Paths are relative to the rule's root: the workspace by default, or the
   * directory `requestDirectory` obtained for rules declaring
   * `root: "userSelected"`.
   */
  fs: {
    readText: (pathFromRoot: string) => Promise<string>;
    /** Read the size and modification time of one file without loading it. */
    stat: (pathFromRoot: string, grantId?: string) => Promise<PluginFsStat>;
    /** Read a bounded byte range; `grantId` is only for a dropped-file grant. */
    readRange: (
      pathFromRoot: string,
      byteOffset: number,
      length: number,
      grantId?: string,
    ) => Promise<PluginFsRange>;
    /**
     * Bounded classified preview of one existing readable file. Images return
     * a data URL; text is capped; binary and oversized files are reported
     * without dumping their bytes.
     */
    readPreview: (pathFromRoot: string) => Promise<PluginFsPreview>;
    /** Open an existing readable file with the operating system's default app. */
    openDefault: (pathFromRoot: string) => Promise<void>;
    /** Reveal an existing readable file in the operating system's file manager. */
    reveal: (pathFromRoot: string) => Promise<void>;
    writeText: (pathFromRoot: string, content: string) => Promise<void>;
    glob: (pattern: string) => Promise<string[]>;
    /**
     * One directory's entries, sorted by name. Lets a plugin walk a tree lazily
     * instead of pulling a whole-repo `glob` and reassembling it. Directories
     * are always listed so the tree stays navigable; files are filtered by the
     * declared read scope, and heavy or protected directories are skipped.
     */
    list: (pathFromRoot: string) => Promise<PluginFsEntry[]>;
    remove: (pathFromRoot: string) => Promise<void>;
    /**
     * Ask the user to point at a directory, which becomes the root for this
     * run's `userSelected` rules. Nothing is remembered across restarts —
     * the grant lives exactly as long as the process.
     */
    requestDirectory: () => Promise<{ path: string; name: string } | null>;
  };
  agent: {
    registerTool: (tool: PluginTool) => Promise<void>;
    unregisterTool: (name: string) => Promise<void>;
    complete: (input: PluginCompleteInput) => Promise<PluginCompleteResult>;
  };
  models: {
    list: () => Promise<PluginModelInfo[]>;
  };
  session: {
    getLlmContext: () => Promise<PluginLlmContext>;
    list: (input?: {
      limit?: number;
      cursor?: string;
      source?: string;
      updatedAfter?: string;
    }) => Promise<PluginSessionListResult>;
    get: (input: { sessionId: string }) => Promise<PluginSessionGetResult>;
    listMessages: (input: {
      sessionId: string;
      limit?: number;
      cursor?: string;
      order?: "asc" | "desc";
      contentLimit?: number;
    }) => Promise<PluginSessionMessageListResult>;
    import: (input: PluginSessionImportInput) => Promise<PluginSessionImportResult>;
    importBatch: (input: PluginSessionBatchImportInput) => Promise<PluginSessionBatchImportResult>;
    rename: (input: { sessionId: string; title: string }) => Promise<{ updated: boolean }>;
    delete: (input: {
      sessionId: string;
      mode?: "trash" | "purge";
    }) => Promise<{ deleted: boolean }>;
  };
  services: {
    /**
     * Register a resident service declared in `contributes.services`. Local
     * bookkeeping only — the host decides when `start` runs.
     */
    register: (service: PluginService) => void;
    /** Drops the registration, stopping the service first if it is running. */
    unregister: (id: string) => Promise<void>;
  };
  bus: {
    publish: (topic: string, payload?: unknown) => Promise<void>;
    /** Resolves to an unsubscribe function. */
    subscribe: (
      topic: string,
      handler: (message: PluginBusMessage) => void,
    ) => Promise<() => Promise<void>>;
  };
  clipboard: {
    readText: () => Promise<string>;
    writeText: (text: string) => Promise<void>;
    getHistory: () => Promise<ClipboardHistoryEntry[]>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  browser: {
    navigate: (input: { url?: string; path?: string }) => Promise<unknown>;
    action: (input: { action: "back" | "forward" | "reload" | "stop" }) => Promise<void>;
    setBounds: (hole: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
    setVisible: (visible: boolean | { visible: boolean }) => Promise<void>;
    getState: () => Promise<unknown>;
    openExternal: () => Promise<void>;
    snapshot: () => Promise<{ tree: string; url: string; title: string }>;
    screenshot: (input?: { fullPage?: boolean }) => Promise<{
      mimeType: string;
      data: string;
      path?: string;
    }>;
    click: (input: { uid: string }) => Promise<void>;
    fill: (input: { uid: string; text: string }) => Promise<void>;
    evaluate: (input: { expression: string }) => Promise<unknown>;
    console: (input?: { limit?: number }) => Promise<{ messages: unknown[] }>;
    cdp: (input: { method: string; params?: unknown }) => Promise<unknown>;
  };
  net: {
    fetch: (input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    }) => Promise<{ status: number; headers: Record<string, string>; bodyText: string }>;
  };
  events: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  };
};

export type PluginModule = {
  onLoad?: () => Promise<void> | void;
  onUnload?: () => Promise<void> | void;
  /** Optional fixed-channel operations for an isolated plugin panel. */
  onPanelInvoke?: (channel: string, payload: unknown) => Promise<unknown> | unknown;
};

/** Upper bound on ExtensionAPI modules one plugin may contribute. */
export const MAX_AGENT_EXTENSIONS_PER_PLUGIN = 8;

export const PLUGIN_PERMISSIONS = [
  "ui.panel",
  "ui.view",
  "ui.microphone",
  "ui.theme",
  "clipboard.read",
  "clipboard.write",
  "notify",
  "fs.read",
  "fs.write",
  "fs.delete",
  "agent.tool.register",
  "agent.prompt.inject",
  "agent.complete",
  "agent.extension",
  "desktop.control",
  "models.list",
  "project.create",
  "session.read",
  "session.import",
  "session.read.own",
  "session.update.own",
  "session.delete.own",
  "net.fetch",
  "shell.openExternal",
  "mcp.server.local",
  "mcp.server.remote",
  "background.service",
  "bus.publish",
  "bus.subscribe",
  "browser.cdp",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export function validateManifest(raw: unknown): {
  ok: boolean;
  manifest?: PluginManifest;
  error?: string;
} {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "manifest must be an object" };
  }
  const m = raw as Partial<PluginManifest>;
  if (typeof m.id !== "string" || !m.id) {
    return { ok: false, error: "manifest.id is required" };
  }
  if (typeof m.name !== "string" || !m.name) {
    return { ok: false, error: "manifest.name is required" };
  }
  if (typeof m.version !== "string" || !m.version) {
    return { ok: false, error: "manifest.version is required" };
  }
  if (typeof m.main !== "string" || !m.main) {
    return { ok: false, error: "manifest.main is required" };
  }
  const mainError = relativePathError(m.main, "manifest.main");
  if (mainError) return { ok: false, error: mainError };
  if (typeof m.schemaVersion !== "number") {
    return { ok: false, error: "manifest.schemaVersion is required" };
  }
  if (m.enabledByDefault !== undefined && typeof m.enabledByDefault !== "boolean") {
    return { ok: false, error: "manifest.enabledByDefault must be a boolean" };
  }
  const authorError = manifestAuthorError(m.author);
  if (authorError) return { ok: false, error: authorError };
  for (const field of ["homepage", "repository"] as const) {
    const value = (m as Record<string, unknown>)[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return { ok: false, error: `manifest.${field} must be a non-empty string` };
    }
  }
  const ui = m.ui as
    | { title?: unknown; panel?: unknown }
    | null
    | undefined;
  if (ui !== undefined) {
    if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
      return { ok: false, error: "manifest.ui must be an object" };
    }
    const titleError = localizedStringError(ui.title, "manifest.ui.title");
    if (titleError) return { ok: false, error: titleError };
    if (ui.panel !== undefined) {
      if (typeof ui.panel !== "string" || !ui.panel.trim()) {
        return { ok: false, error: "manifest.ui.panel must be a non-empty string" };
      }
      const panelError = relativePathError(ui.panel, "manifest.ui.panel");
      if (panelError) return { ok: false, error: panelError };
    }
  }
  const contributesError = validateContributions(m.contributes);
  if (
    !contributesError &&
    (m.contributes?.agentExtensions?.length ?? 0) > 0 &&
    !(m.permissions ?? []).includes("agent.extension")
  ) {
    return { ok: false, error: "contributes.agentExtensions requires the agent.extension permission" };
  }
  if (contributesError) {
    return { ok: false, error: contributesError };
  }
  const net = m.net as { domains?: unknown } | null | undefined;
  if (net !== undefined) {
    if (!net || typeof net !== "object" || Array.isArray(net)) {
      return { ok: false, error: "manifest.net must be an object" };
    }
    const domains = parseNetDomains(net.domains);
    if (!domains.ok) {
      return { ok: false, error: `manifest.${domains.error}` };
    }
  }
  const fs = parseFsPolicy((m as { fs?: unknown }).fs);
  if (!fs.ok) {
    return { ok: false, error: `manifest.${fs.error}` };
  }
  // A scope nobody can use is an authoring slip worth catching at install
  // rather than at the first silently-refused call.
  const granted = new Set(resolveFsAccess(m).permissions);
  for (const mode of PLUGIN_FS_MODES) {
    if (fs.policy?.[mode] && !granted.has(`fs.${mode}`)) {
      return {
        ok: false,
        error: `manifest.fs.${mode} needs the fs.${mode} permission`,
      };
    }
  }
  return { ok: true, manifest: m as PluginManifest };
}

/**
 * Structural checks for the contribution shapes the host activates. Paths are
 * only checked for shape here; existence is verified by the host.
 */
export function validateContributions(
  contributes: PluginManifest["contributes"],
): string | undefined {
  if (contributes === undefined) return undefined;
  if (typeof contributes !== "object" || contributes === null || Array.isArray(contributes)) {
    return "manifest.contributes must be an object";
  }

  const settings = contributes.settings ?? [];
  const settingKeys = new Set<string>();
  const commands = contributes.commands ?? [];
  if (!Array.isArray(commands)) return "contributes.commands must be an array";
  const commandIds = new Set<string>();
  for (const command of commands) {
    if (!command || typeof command !== "object") {
      return "contributes.commands entries must be objects";
    }
    if (typeof command.id !== "string" || !command.id.trim()) {
      return "contributes.commands entries need an id";
    }
    if (typeof command.title !== "string" || !command.title.trim()) {
      return `command "${command.id}" requires a title`;
    }
    if (commandIds.has(command.id)) return `duplicate command id "${command.id}"`;
    commandIds.add(command.id);
  }
  for (const setting of settings) {
    if (!setting || typeof setting !== "object") {
      return "contributes.settings entries must be objects";
    }
    if (
      typeof setting.key !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(setting.key)
    ) {
      return "contributes.settings key must match [a-zA-Z][a-zA-Z0-9._-]{0,63}";
    }
    if (settingKeys.has(setting.key)) {
      return `duplicate setting key "${setting.key}"`;
    }
    settingKeys.add(setting.key);
    if (typeof setting.title !== "string" || !setting.title.trim()) {
      return `setting "${setting.key}" requires a title`;
    }
    if (
      setting.type !== "string" &&
      setting.type !== "number" &&
      setting.type !== "boolean" &&
      setting.type !== "select" &&
      setting.type !== "json" &&
      setting.type !== "shortcut"
    ) {
      return `setting "${setting.key}" has an unsupported type`;
    }
    if (setting.secret === true) {
      return `setting "${setting.key}" cannot be secret in this release`;
    }
    if (setting.type === "shortcut") {
      if (setting.scope !== undefined && setting.scope !== "plugin") {
        return `setting "${setting.key}" only supports the plugin shortcut scope`;
      }
      if (typeof setting.command !== "string" || !setting.command.trim()) {
        return `shortcut setting "${setting.key}" requires a command`;
      }
      if (!commandIds.has(setting.command)) {
        return `shortcut setting "${setting.key}" references an undeclared command`;
      }
      if (setting.default !== undefined && !isValidShortcutShape(setting.default)) {
        return `shortcut setting "${setting.key}" has an invalid default`;
      }
    }
    if (setting.type === "select") {
      if (!Array.isArray(setting.enum) || setting.enum.length === 0) {
        return `select setting "${setting.key}" requires enum options`;
      }
      for (const option of setting.enum) {
        if (
          !option ||
          typeof option !== "object" ||
          typeof option.label !== "string" ||
          !["string", "number", "boolean"].includes(typeof option.value)
        ) {
          return `select setting "${setting.key}" has an invalid enum option`;
        }
      }
    }
  }

  for (const entry of contributes.skills ?? []) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (typeof path !== "string" || !path.trim()) {
      return "contributes.skills entries need a path";
    }
    const pathError = relativePathError(path, "contributes.skills path");
    if (pathError) return pathError;
  }

  const agentExtensions = contributes.agentExtensions ?? [];
  if (!Array.isArray(agentExtensions)) return "contributes.agentExtensions must be an array";
  if (agentExtensions.length > MAX_AGENT_EXTENSIONS_PER_PLUGIN) {
    return `contributes.agentExtensions allows at most ${MAX_AGENT_EXTENSIONS_PER_PLUGIN} entries`;
  }
  for (const entry of agentExtensions) {
    if (typeof entry !== "string" || !entry.trim()) {
      return "contributes.agentExtensions entries must be paths";
    }
    const pathError = relativePathError(entry, "contributes.agentExtensions path");
    if (pathError) return pathError;
    if (!/\.(ts|mts|js|mjs)$/.test(entry)) {
      return "contributes.agentExtensions entries must be .ts or .js files";
    }
  }

  const themeIds = new Set<string>();
  for (const theme of contributes.themes ?? []) {
    if (!theme || typeof theme !== "object") return "contributes.themes entries must be objects";
    if (typeof theme.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(theme.id)) {
      return "contributes.themes id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    }
    if (themeIds.has(theme.id)) return `duplicate theme id "${theme.id}"`;
    themeIds.add(theme.id);
    if (typeof theme.path !== "string" || !theme.path.endsWith(".css")) {
      return `theme "${theme.id}" path must be a .css file`;
    }
    const pathError = relativePathError(theme.path, `theme "${theme.id}" path`);
    if (pathError) return pathError;
    if (theme.base !== undefined && theme.base !== "light" && theme.base !== "dark") {
      return `theme "${theme.id}" base must be "light" or "dark"`;
    }
  }

  const viewIds = new Set<string>();
  for (const view of contributes.views ?? []) {
    if (!view || typeof view !== "object") return "contributes.views entries must be objects";
    if (typeof view.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(view.id)) {
      return "contributes.views id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    }
    if (viewIds.has(view.id)) return `duplicate view id "${view.id}"`;
    viewIds.add(view.id);
    if (view.title === undefined) return `view "${view.id}" requires a title`;
    const titleError = localizedStringError(view.title, `view "${view.id}" title`);
    if (titleError) return titleError;
    if (typeof view.title === "string" && !view.title.trim()) {
      return `view "${view.id}" requires a title`;
    }
    if (typeof view.entry !== "string" || !view.entry.trim()) {
      return `view "${view.id}" requires an entry`;
    }
    const entryError = relativePathError(view.entry, `view "${view.id}" entry`);
    if (entryError) return entryError;
    if (view.order !== undefined && !Number.isFinite(view.order)) {
      return `view "${view.id}" order must be a number`;
    }
    // `icon` is intentionally unchecked: an unknown token degrades to a letter
    // tile, so rejecting one would break a plugin over a cosmetic detail.
  }

  const sessionSourceIds = new Set<string>();
  for (const source of contributes.sessionSources ?? []) {
    if (!source || typeof source !== "object") {
      return "contributes.sessionSources entries must be objects";
    }
    if (
      typeof source.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(source.id)
    ) {
      return "session source id must match [a-zA-Z][a-zA-Z0-9._-]{0,63}";
    }
    if (sessionSourceIds.has(source.id)) {
      return `duplicate session source id "${source.id}"`;
    }
    sessionSourceIds.add(source.id);
    const labelError = localizedStringError(source.label, `session source "${source.id}" label`);
    if (labelError) return labelError;
    if (typeof source.label === "string" && !source.label.trim()) {
      return `session source "${source.id}" label must not be empty`;
    }
  }

  const serverIds = new Set<string>();
  for (const server of contributes.mcpServers ?? []) {
    const result = validateMcpServer(server);
    if (!result.ok) return result.error;
    if (serverIds.has(result.server.id)) return `duplicate mcp server id "${result.server.id}"`;
    serverIds.add(result.server.id);
  }

  const serviceIds = new Set<string>();
  for (const service of contributes.services ?? []) {
    if (!service || typeof service !== "object") {
      return "contributes.services entries must be objects";
    }
    if (typeof service.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(service.id)) {
      return "contributes.services id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    }
    if (serviceIds.has(service.id)) return `duplicate service id "${service.id}"`;
    serviceIds.add(service.id);
  }

  const bus = contributes.bus;
  if (bus !== undefined) {
    if (typeof bus !== "object" || bus === null || Array.isArray(bus)) {
      return "contributes.bus must be an object";
    }
    for (const topic of bus.publish ?? []) {
      if (typeof topic !== "string" || !isValidBusTopic(topic)) {
        return `contributes.bus.publish topic "${String(topic)}" is not a valid topic`;
      }
    }
    for (const pattern of bus.subscribe ?? []) {
      if (typeof pattern !== "string" || !isValidBusTopicPattern(pattern)) {
        return `contributes.bus.subscribe pattern "${String(pattern)}" is not valid`;
      }
    }
  }

  return undefined;
}

function isValidShortcutShape(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split("+").filter(Boolean);
  if (parts.length < 2 && !/^F(?:[1-9]|1[0-2])$/i.test(value)) return false;
  const key = parts.at(-1) ?? "";
  if (!/^(?:[a-z]|[0-9]|F(?:[1-9]|1[0-2]))$/i.test(key) &&
      !/^(?:Enter|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Comma|Period|Equal|Minus|Slash|Backslash|Semicolon|Quote|Bracket(?:Left|Right)|Backquote)$/.test(key)) {
    return false;
  }
  return parts.slice(0, -1).every((part) => ["Mod", "Ctrl", "Alt", "Shift"].includes(part));
}

/**
 * Shape check for a label that may be plain or localized. A localized label
 * must carry both shipped locales: a half-translated title would silently fall
 * back at runtime and read as a plugin bug rather than a manifest one.
 */
function localizedStringError(value: unknown, field: string): string | undefined {
  if (value === undefined || typeof value === "string") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be a string or { en, "zh-CN" }`;
  }
  const localized = value as Record<string, unknown>;
  for (const locale of ["en", "zh-CN"] as const) {
    const entry = localized[locale];
    if (typeof entry !== "string" || !entry.trim()) {
      return `${field}.${locale} is required for localized titles`;
    }
  }
  return undefined;
}

function manifestAuthorError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.trim() ? undefined : "manifest.author must not be empty";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "manifest.author must be a string or { name, email?, url? }";
  }
  const author = value as Record<string, unknown>;
  if (typeof author.name !== "string" || !author.name.trim()) {
    return "manifest.author.name is required";
  }
  for (const field of ["email", "url"] as const) {
    if (author[field] !== undefined && typeof author[field] !== "string") {
      return `manifest.author.${field} must be a string`;
    }
  }
  return undefined;
}

function relativePathError(value: string, field: string): string | undefined {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return `${field} must not be an absolute path`;
  }
  if (value.split(/[\\/]/).includes("..")) {
    return `${field} must not contain ".."`;
  }
  return undefined;
}

/** Forced tool name prefix for plugin tools exposed to the agent. */
export function pluginToolName(pluginId: string, toolName: string): string {
  const safePlugin = pluginId.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `plugin_${safePlugin}_${safeTool}`;
}

/** Local tool key for a tool discovered on a plugin-declared MCP server. */
export function pluginMcpToolKey(serverId: string, toolName: string): string {
  return `${serverId}_${toolName}`;
}

/**
 * Forced tool name prefix for a tool on an MCP server the user configured
 * themselves. `mcp_` rather than `plugin_` keeps the two provenances legible in
 * the timeline and in audit records: one came from installed code, the other
 * from a command the user typed.
 */
export function userMcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp_${safeServer}_${safeTool}`;
}

/** Stable, globally unique id for a skill contributed by a plugin. */
export function pluginSkillId(pluginId: string, skillId: string): string {
  return `${pluginId}/${skillId}`;
}

/** Stable, globally unique id for a theme contributed by a plugin. */
export function pluginThemeId(pluginId: string, themeId: string): string {
  return `plugin:${pluginId}:${themeId}`;
}

export {
  parseSkillFrontmatter,
  skillIdFromPath,
  type ParsedSkillDoc,
} from "./skills.js";
export {
  decodeCssEscapes,
  sanitizeThemeCss,
  THEME_CSS_MAX_BYTES,
  type ThemeCssResult,
} from "./theme-css.js";
export {
  busTopicAllowed,
  isValidBusTopic,
  isValidBusTopicPattern,
  matchesBusTopic,
  BUS_TOPIC_MAX_LENGTH,
  BUS_TOPIC_MAX_SEGMENTS,
} from "./bus-topics.js";
export {
  isLoopbackHost,
  resolveMcpRefs,
  validateMcpServer,
  MCP_ENV_KEY,
  MCP_HEADER_KEY,
  MCP_SERVER_ID,
  type McpRefResolution,
  type McpValidationResult,
} from "./mcp-config.js";
export {
  isLocalNetDomain,
  isNetHostAllowed,
  isNetUrlAllowed,
  parseNetDomains,
  type PluginNetDomain,
} from "./net-policy.js";
export {
  fsGlobIgnoresCase,
  isDeniedFsPath,
  isFsPathInScope,
  isWholeTreePattern,
  matchFsGlob,
  normalizeFsPath,
  parseFsPolicy,
  resolveFsAccess,
  FS_DENY_DIR_SEGMENTS,
  FS_DENY_FILE_PATTERNS,
  LEGACY_FS_PERMISSIONS,
  PLUGIN_FS_MODES,
  type MatchFsGlobOptions,
  type PluginFsMode,
  type PluginFsPolicy,
  type PluginFsRoot,
  type PluginFsRule,
  type ResolvedFsAccess,
} from "./fs-policy.js";
