import { isValidBusTopic, isValidBusTopicPattern } from "./bus-topics.js";
import {
  parseFsPolicy,
  resolveFsAccess,
  PLUGIN_FS_MODES,
  type PluginFsPolicy,
} from "./fs-policy.js";
import { validateMcpServer } from "./mcp-config.js";
import { parseNetDomains, type PluginNetDomain } from "./net-policy.js";
import {
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_RENDERER_DATA,
  type PluginRendererActionName,
  type PluginRendererDataKey,
} from "./renderer.js";
import {
  isExternalThemeAssetPath,
  isThemeAssetPath,
  normalizeThemeAssetPath,
  THEME_ASSET_EXTENSIONS,
} from "./theme-css.js";
import {
  validatePluginThemeVariableDeclaration,
  type PluginThemeVariableContrib,
} from "./theme-variables.js";

/**
 * Manifest id shape frozen by docs/spec/07-plugins/02-plugin-manifest-schema.md:
 * a lowercase dotted namespace such as `demo.hello` or `pi.browser`.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;

/** `author` may be a display string or a contact object (manifest schema §2). */
export type PluginManifestAuthor =
  | string
  | string
  | { name: string; email?: string; url?: string };

/**
 * One locale's display strings (`manifest.i18n`).
 *
 * `en` and `zh-CN` are the contract locales: the shell reads `zh-CN` for every
 * Chinese locale and English for everything else. Every field is optional, and
 * a partially translated block falls back per field, so a missing one keeps the
 * author's own `name` / `description` instead of blanking it out.
 */
export type PluginDisplayI18n = {
  name?: string;
  description?: string;
  safetyNotes?: string;
};

/** Locale id → display strings, as a plugin declares them in `manifest.i18n`. */
export type PluginI18nMap = Record<string, PluginDisplayI18n>;
export type PluginManifest = {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  /**
   * Display strings per locale. The flat `name`/`description` above stay the
   * author's own language and remain the fallback; the shell shows the entry
   * matching the app language and only reads these two contract locales.
   */
  i18n?: PluginI18nMap;
  author?: PluginManifestAuthor;
  homepage?: string;
  repository?: string;
  /**
   * Headless entry: a plugin-relative module the host runs in its own process.
   * Optional since the renderer host landed — a UI-only plugin may declare just
   * `renderer`, or only a plugin page. `pluginHasEntry` holds the rule that at
   * least one entry exists.
   */
  main?: string;
  /**
   * Trusted renderer entry: a plugin-relative ES module that runs inside the
   * host renderer process and registers React component slots (spec
   * 07-plugins/16). Requires the `renderer.extension` permission. Fetched and
   * evaluated lazily, the first time one of its slots actually renders.
   */
  renderer?: string;
  /**
   * Host-owned data this plugin's renderer components may read. Optional and
   * independent of `renderer`: an omitted list declares nothing, so a manifest
   * that never mentions the field keeps working unchanged. Every name must
   * come from `PLUGIN_RENDERER_DATA` — an unknown, duplicated, or non-string
   * entry is refused at install.
   */
  rendererData?: PluginRendererDataKey[];
  /**
   * Host-side actions this plugin's renderer components may ask for. Optional
   * and independent of `renderer`. Every name must come from
   * `PLUGIN_RENDERER_ACTIONS`; the declaration records intent for install
   * review, and the host still decides whether an action is implemented.
   */
  rendererActions?: PluginRendererActionName[];
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
    /**
     * Panel placement. `"panel"` (default) keeps the host-owned 46px titlebar
     * band and its three-control capsule. `"widget"` opens the same sandboxed
     * page as a transparent, frameless floating surface: no band, no capsule,
     * a drag map over the whole window, and a host context menu that closes,
     * minimizes, or pins it. A widget may be smaller than a panel — see
     * `PLUGIN_PANEL_MIN_SIZE` / `PLUGIN_PANEL_WIDGET_MIN_SIZE` in the host.
     */
    shape?: "panel" | "widget";
    /** Floating widget placement only: keep the surface above other windows. */
    alwaysOnTop?: boolean;
    /** Overrides the per-shape default: panels are resizable, widgets are not. */
    resizable?: boolean;
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
    /**
     * Providers this plugin adds to Settings' provider list. Requires the
     * `provider.register` permission; each row is read-only for the user and
     * refreshed from this manifest on every load.
     */
    providers?: PluginProviderContrib[];
    settings?: PluginSettingContrib[];
    themes?: PluginThemeContrib[];
    /** A host-rendered, image-card theme selector in Settings → Extensions. */
    scenicThemes?: PluginScenicThemesContrib;
    /** Native window background for this plugin's themes (ADR 0248). */
    windowAppearance?: PluginWindowAppearanceContrib;
    mcpServers?: PluginMcpServerContrib[];
    services?: PluginServiceContrib[];
    bus?: PluginBusContrib;
    /** Surfaces the plugin docks inside the host's work panel. */
    views?: PluginViewContrib[];
    /** External session namespaces this plugin may import and own. */
    sessionSources?: PluginSessionSourceContrib[];
    /**
     * System-wide accelerators this plugin may own (`keyboard.globalShortcut`).
     * Each entry maps one accelerator to one of the plugin's own commands; the
     * host registers, conflict-checks, and releases it with the plugin.
     */
    globalShortcuts?: PluginGlobalShortcutContrib[];
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

/**
 * Host-owned chrome labels (`ui.title`, views, destinations, session sources).
 * Do not use this for plugin-owned copy; read `pi.app.getLocale` instead
 * (ADR 0280). Shell UI may add locales; plugins still ship en + zh-CN.
 */
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

/**
 * One completed turn as a flat fact row (`usage.read`). The host serves raw
 * counters — per-turn tokens and identifiers only; no message body ever
 * crosses the bridge, and every dashboard shape (streaks, heatmaps, shares)
 * stays the plugin's own computation.
 */
export type PluginUsageTurn = {
  turnId: string;
  sessionId: string;
  sessionTitle: string | null;
  projectId: number | null;
  providerId: string | null;
  modelId: string | null;
  startedAt: number;
  endedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

/**
 * A keyset-paginated page of completed turns, ordered by `endedAt`
 * ascending. `nextCursor` is opaque: pass it back as `cursor` to fetch the
 * next page; it is `null` when the window is exhausted.
 */
export type PluginUsageTurnPage = {
  turns: PluginUsageTurn[];
  nextCursor: string | null;
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
  /** Author-language label for the generated sheet. Not a locale map (ADR 0280). */
  title: string;
  /** Author-language help text for the generated sheet. */
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
  /**
   * Package-relative or absolute paths (extension whitelist, 4 MB summed) this theme's CSS may
   * reference with `url()`. The host rewrites each matching reference to its own
   * `plugin-asset://` scheme; anything not declared here is still refused.
   */
  assets?: string[];
  /** Values accepted by the typed `pi.themes.setVariables` API. */
  variables?: PluginThemeVariableContrib[];
};

/**
 * Data only: the host owns every DOM node, style, and interaction for this
 * Settings destination so a scenic canvas never sits behind a plugin document.
 */
export type PluginScenicThemesContrib = {
  id: string;
  label: PluginLocalizedString;
  description: PluginLocalizedString;
  keywords?: PluginLocalizedString[];
  icon: "palette";
  themes: PluginScenicThemeCardContrib[];
};

export type PluginScenicThemeCardContrib = {
  themeId: string;
  label: PluginLocalizedString;
  description: PluginLocalizedString;
  previewAsset: string;
};

/** Wire format a contributed provider may declare. Absent means `chat_completions`. */
export const PLUGIN_PROVIDER_API_STYLES = [
  "chat_completions",
  "opencode_go",
  "responses",
  "anthropic_messages",
  "google_generative_ai",
  "openai_codex_responses",
  "pi_messages",
] as const;

export type PluginProviderApiStyle = (typeof PLUGIN_PROVIDER_API_STYLES)[number];

/**
 * Credential a contributed provider accepts. Absent means `api_key`. `oauth`
 * is deliberately absent: a plugin OAuth provider needs a Host-owned login
 * flow that does not exist yet, so a declaration asking for one is refused
 * instead of materializing a row nobody can sign in to.
 */
export const PLUGIN_PROVIDER_AUTH_KINDS = ["api_key", "none"] as const;

export type PluginProviderAuthKind = (typeof PLUGIN_PROVIDER_AUTH_KINDS)[number];

/** Upper bound on `contributes.providers` entries one plugin may declare. */
export const MAX_PLUGIN_PROVIDERS_PER_PLUGIN = 8;

/** Upper bound on the model list of one contributed provider. */
export const MAX_PLUGIN_PROVIDER_MODELS = 64;

/** One model a contributed provider exposes to the model picker. */
export type PluginProviderModelContrib = {
  /** Model id sent on the wire, 1..256 characters. */
  id: string;
  /** Label shown in the picker; the id when omitted. */
  name?: string;
  /** Context window in tokens; the runtime default when omitted. */
  contextWindow?: number;
  /** Max output tokens; the runtime default when omitted. */
  maxTokens?: number;
  /** Whether the model accepts image input. */
  supportsImages?: boolean;
};

/**
 * One provider a plugin adds to Settings' provider list. The plugin supplies
 * the endpoint and model catalog; the user's API key stays in the host and is
 * never handed to the plugin. The row appears as `plugin:<pluginId>:<id>` and
 * is read-only in Settings.
 */
export type PluginProviderContrib = {
  /** Plugin-local id matching [a-zA-Z][a-zA-Z0-9_-]{0,63}, unique per plugin. */
  id: string;
  /** Display name for the provider row; required and non-empty. */
  name: string;
  /** Vendor the row is attributed to; `custom` when omitted. */
  vendorKey?: string;
  /** Endpoint the runtime reaches; must be an absolute http(s) URL. */
  baseUrl?: string;
  apiStyle?: PluginProviderApiStyle;
  authKind?: PluginProviderAuthKind;
  /** 1..64 models with unique ids. */
  models: PluginProviderModelContrib[];
};

/**
 * Native window chrome a theme may ask for. Only honoured while one of this
 * plugin's themes is the selected theme, and only with the
 * `ui.window.appearance` grant.
 */
export type PluginWindowAppearanceContrib = {
  /** `#rrggbb` or `#rrggbbaa`, applied per resolved palette. */
  backgroundColor?: { light?: string; dark?: string };
};

/** The only colour form a contributed window background may take. */
export const WINDOW_BACKGROUND_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export function isWindowBackgroundColor(value: unknown): value is string {
  return typeof value === "string" && WINDOW_BACKGROUND_COLOR_PATTERN.test(value);
}

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
/** One system-wide accelerator a plugin declares (`keyboard.globalShortcut`). */
export type PluginGlobalShortcutContrib = {
  /** Local id, unique inside the plugin; also the handle later handed back. */
  id: string;
  /**
   * Command to run, which must be declared in `contributes.commands`. A
   * shortcut carries no payload and can only reach this plugin's own commands.
   */
  command: string;
  /**
   * Accelerator the host registers until the user overrides it. The host
   * reports an OS-reserved or already-claimed accelerator as a registration
   * error rather than silently replacing the other owner.
   */
  default?: string;
};

/** One accelerator the host currently holds for this plugin. */
export type PluginGlobalShortcut = {
  id: string;
  accelerator: string;
  command: string;
  /** False when the OS or another owner holds the accelerator instead. */
  registered: boolean;
  /** Why registration failed, when it did. */
  error?: string;
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

export type PluginSpeechRole = "transcribe" | "synthesize";

export type PluginSpeechHandleInput = {
  protocol: string;
  role: PluginSpeechRole;
  modelId: string;
  voice?: string;
  format?: string;
  extra?: Record<string, string>;
  text?: string;
  language?: string;
  audio?: { mimeType: string; data: string };
};

export type PluginSpeechHandleResult =
  | { kind: "text"; text: string }
  | { kind: "audio"; mimeType: string; data: string }
  | {
      kind: "http";
      call: {
        url: string;
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: unknown;
        parse: "bytes" | "json-text" | "json-path" | "openai-transcription" | "openai-chat-audio";
        jsonPath?: string;
      };
    };

export type PluginSpeechAdapter = {
  protocol: string;
  label: string;
  roles: PluginSpeechRole[];
  handle: (input: PluginSpeechHandleInput) => Promise<PluginSpeechHandleResult> | PluginSpeechHandleResult;
};

/** Spend one plugin tool call reports for itself. The host records it as its
 * own component of the turn (`pluginToolUsage`), never folded into the model's
 * input/output token counts. Requires the `runtime.tool.extend` permission.
 */
export type PluginToolUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Defaults to the sum of the parts above. */
  totalTokens?: number;
};

/**
 * A plugin tool's own result for the `runtime.tool.extend` slot (ADR 0295
 * slot 5). A result that carries any of these fields is read as this shape, so
 * `content` reaches the model as content instead of a JSON blob; a result with
 * none of them keeps the previous behaviour and is rendered as before.
 *
 * `addedToolNames` introduces tools: each name must already be in the session's
 * tool catalogue (a contributed or MCP tool the model has not activated yet).
 * They become available from the next model turn onward and are marked as
 * plugin-introduced wherever the catalogue is shown. `usage` reports the call's
 * own spend. `terminate` asks the agent to stop after the current tool batch,
 * and the kernel stops only when **every** finalized result in the batch asks
 * for it, so one tool's request never cuts a batch short.
 *
 * The permission is checked against the plugin's recorded grants before the
 * fields leave the host: a plugin without `runtime.tool.extend` is refused (the
 * fields are dropped and the refusal is audited), never silently trusted.
 */
export type PluginToolResult = {
  /** Text or image content returned to the model. */
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  /** Arbitrary structured details for logs or UI rendering. */
  details?: unknown;
  usage?: PluginToolUsage;
  addedToolNames?: string[];
  terminate?: boolean;
  /** Convenience alias for a single text block when `content` is omitted. */
  text?: string;
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
  execute: (
    args: unknown,
    ctx?: PluginToolExecContext,
  ) => Promise<PluginToolResult | unknown> | PluginToolResult | unknown;
};

export type PluginToolExecContext = {
  sessionId?: string;
  turnId?: string;
  /** Durable session operating mode. Host-core is authoritative (ADR 0211). */
  mode?: "agent" | "plan" | "goal";
  /** Executor model for this session, `providerId/modelId`. Configuration, not transcript. */
  modelKey?: string;
  thinkingLevel?: string;
  /**
   * The turn's cancellation token (ADR 0295 slot 3): it aborts when the user
   * stops the turn, when a plugin asks the host to stop it (`runtime.turn.abort`),
   * or when the host abandons the turn. Long-running work should pass it to
   * `fetch` or watch it and stop.
   */
  signal?: AbortSignal;
  log: (msg: string) => void;
};

/**
 * One turn's model tokens, as the host recorded them for that turn. `total` is
 * `input + output`; a provider's own total (which may count reasoning tokens
 * differently) stays inside {@link PluginTurnFacts.usage}.
 */
export type PluginTurnTokens = {
  input: number;
  output: number;
  total: number;
};

/** One tool's share of a turn's executed calls. */
export type PluginToolCallSummary = {
  /** Tool name as the host's audit record carries it. */
  toolName: string;
  calls: number;
  ok: number;
  failed: number;
  /** Distinct error codes of the failed calls, sorted; empty when none failed. */
  errorCodes: string[];
};

/** A turn's executed tool calls; `total` is `ok + failed` for every turn. */
export type PluginToolCallFacts = {
  total: number;
  ok: number;
  failed: number;
  /** One entry per tool, ordered by tool name. */
  byTool: PluginToolCallSummary[];
};

/** One file a turn touched, with the operation that turn performed on it. */
export type PluginTurnFile = {
  sessionId: string;
  sessionTitle: string | null;
  path: string;
  /** `create | write | edit | download | delete`. */
  op: string;
  /** The turn that touched the file; `null` when the touch belonged to no turn. */
  turnId: string | null;
  updatedAt: string;
};

/**
 * The facts about one turn, exactly as the host assembled them — what
 * `pi.turnFacts()` answers (ADR 0295 slot 9, permission
 * `runtime.turn.facts`).
 *
 * Every number comes from the host's own tables for that turn. This is **not**
 * the plugin's view of the event stream: `runtime.turn.watch` delivers events
 * best-effort, with no receipt and no redelivery, so counting what a plugin
 * happened to see is a different number — which is why slot 9 exists. Nothing
 * here is conversation text either; use `pi.recap()` for content.
 */
export type PluginTurnFacts = {
  sessionId: string;
  turnId: string;
  /** `running | completed | aborted | error`. */
  status: string;
  providerId: string | null;
  modelId: string | null;
  /** The turn's own terminal error code, not a tool's. */
  errorCode: string | null;
  startedAt: string;
  /** `null` while the turn is still running. */
  endedAt: string | null;
  /** `endedAt - startedAt` in milliseconds; `null` while running. */
  durationMs: number | null;
  tokens: PluginTurnTokens;
  /** The provider's usage record as the host stored it, or `null`. */
  usage: unknown;
  /**
   * Spend the turn's plugin tools reported (`runtime.tool.extend`). It is its
   * own component and never part of `tokens`.
   */
  pluginToolUsage: unknown;
  toolCalls: PluginToolCallFacts;
  /** The files the turn touched, oldest touch first. */
  files: PluginTurnFile[];
  /** True when `files` hit the requested limit and holds only the first touches. */
  filesTruncated: boolean;
};

/**
 * What `pi.recap()` answered (ADR 0295 slot 8, permission
 * `runtime.turn.recap`; a whole-session read additionally needs
 * `runtime.session.read`, rule 7).
 *
 * The two scopes answer different things, and the turn scope says plainly what
 * the host cannot answer yet: one turn's numbers are host-owned
 * (`pi.turnFacts()`), while one turn's conversation text has no host read path
 * — the transcript is not queryable per turn. `messages` is therefore `null`
 * with `messagesUnavailable`, never an empty list that could be mistaken for a
 * turn that said nothing. The whole session's rows are readable, and that is
 * what `scope: "session"` returns.
 */
export type PluginTurnRecap =
  | {
      /** One turn. */
      scope: "turn";
      sessionId: string;
      turnId: string;
      /** The same facts `pi.turnFacts()` returns for that turn. */
      facts: PluginTurnFacts;
      /** Always `null`: no host read returns one turn's conversation text. */
      messages: null;
      /** Why `messages` is absent, so an empty turn is never implied. */
      messagesUnavailable: "no-host-turn-read";
    }
  | {
      /** The whole session. */
      scope: "session";
      sessionId: string;
      /** Newest last, in the host's transcript shape. */
      messages: ReadonlyArray<unknown>;
      /** Physical transcript bounds, when a host supplies paged reads. */
      title?: string;
      messageStart?: number;
      messageEnd?: number;
      /** True when older rows exist outside the returned window. */
      truncated: boolean;
    };

/**
 * What `pi.continueTurn()` did (ADR 0295 slot 10, permission
 * `runtime.turn.continue`).
 *
 * The continuation is a real, durable turn queued on the host — the same queue
 * a message the user types goes through — so it survives a restart and runs
 * after the current turn ends, or right away when the session is idle. There
 * is no numeric quota: what replaces one is visibility (a row in the
 * transcript) and the audit trail, not a budget a plugin has to guess.
 */
export type PluginTurnContinuation = {
  /**
   * The queued turn's id. The agent turn that actually runs from it is created
   * at the next turn boundary and carries its own durable turn id, so this is
   * not a `pi.turnFacts()` key.
   */
  queuedTurnId: string;
};

/** Text of the turn to continue with, either bare or as `{ message }`. */
export type PluginTurnContinueInput = string | { message?: string };

/**
 * The three runtime-slot calls an agent extension makes for itself (ADR 0295).
 * They are declared here because the upstream `ExtensionAPI` type has no member
 * for them; the agent sidecar's `pi` object implements them, and each one is
 * separately granted.
 *
 * Every call reports a refusal instead of throwing: a plugin that does not hold
 * the permission gets `undefined` **and** a `permission_denied` diagnostic on
 * the plugin row naming the permission and the call. `undefined` is also the
 * answer when the host cannot answer at all — an unknown turn, or a failed
 * read — and that failure is reported the same way, so a missing answer is
 * never silent.
 */
export type PluginTurnApi = {
  /** Own non-secret settings snapshot. Refreshed when the host relaunches the runtime. */
  getPluginSettings(): Readonly<Record<string, unknown>>;
  /**
   * Slot 9 facts about one turn — status, provider and model, tokens, the
   * turn's own plugin-tool spend, duration, executed tool calls with their
   * outcomes and error codes, and the files it touched with their operations.
   *
   * Permission: `runtime.turn.facts` (low risk — numbers, no conversation
   * text). Returns `undefined` when refused, when the turn is unknown (a turn
   * the host never recorded is not answered with zeroes), or when the read
   * failed.
   *
   * `turnId` defaults to the running turn. `limit` caps the file list
   * (default 200, ceiling 499); `filesTruncated` says whether the cap was hit.
   * Cost: one host read per call, cheap next to a provider request, but a real
   * read — do not poll it from a per-message handler.
   */
  turnFacts(input?: { turnId?: string; limit?: number }): Promise<PluginTurnFacts | undefined>;
  /**
   * Slot 8 read of what a turn contained.
   *
   * Permission: `runtime.turn.recap`. `scope: "session"` reads conversation
   * content and therefore **also** needs `runtime.session.read` (rule 7):
   * without it the call is refused and the diagnostic names that permission.
   * Reads are not recorded one by one — the install review and the plugin row
   * are the consent surface.
   *
   * Returns `undefined` when refused or when the read failed. `scope: "turn"`
   * (the default) answers with that turn's facts and says
   * `messagesUnavailable: "no-host-turn-read"`, because one turn's text has no
   * host read path yet. `scope: "session"` answers with the newest `limit`
   * transcript rows (default 200, ceiling 500) plus `truncated`.
   *
   * Risk: the session scope hands the plugin what was said. Ask for the
   * narrowest scope that answers the question, and read what the plugin needs
   * rather than archiving a transcript.
   */
  recap(input?: {
    scope?: "turn" | "session";
    /** Session scope only; omitted reads the current session. Same read grant. */
    sessionId?: string;
    /** Exclusive physical line cursor from the previous messageStart. */
    before?: number;
    turnId?: string;
    limit?: number;
  }): Promise<PluginTurnRecap | undefined>;
  /**
   * Slot 10 continuation: start another turn after this one ends.
   *
   * Permission: `runtime.turn.continue`. Returns `undefined` when refused or
   * when the host could not queue it.
   *
   * Risk: the continuation costs a full provider request the user did not type,
   * and there is no quota (rule 9), so asking for a turn where it adds nothing
   * spends the user's money and attention.
   *
   * The queued turn is a real, visible row and it names the plugin that asked
   * for it: `continueTurn` is the only extension-facing way to queue a turn and
   * it always carries the plugin id and display label, which host-core stores
   * on the queue row and on the transcript row it becomes (ADR 0293).
   */
  continueTurn(input: PluginTurnContinueInput): Promise<PluginTurnContinuation | undefined>;
};

/**
 * The `input` event's payload (ADR 0295 slot 1, permission
 * `runtime.send.before`).
 *
 * It fires once per prompt, after the desktop has accepted and stored the
 * user's message and before that message enters the agent, so a handler reads
 * exactly what is about to be queued — attachments included — while the text
 * the user typed stays on their row.
 *
 * ```ts
 * pi.on("input", (event) => {
 *   if (event.text.startsWith("?quick ")) {
 *     return { action: "transform", text: `Answer briefly: ${event.text.slice(7)}` };
 *   }
 *   return { action: "continue" };
 * });
 * ```
 */
export type PluginInputEvent = {
  type: "input";
  sessionId: string;
  turnId: string;
  /** The text being queued, as the current handler chain sees it. */
  text: string;
  /** Image attachments carried inline for this turn. */
  images: ReadonlyArray<{ name: string; mimeType?: string; data: string }>;
  /** Every attachment of the message, images included, by reference. */
  attachments: ReadonlyArray<{
    name: string;
    ref: string;
    kind: "image" | "file";
    mimeType?: string;
    size?: number;
  }>;
  source: "rpc" | "extension";
};

/**
 * What an `input` handler answers (ADR 0295 slot 1), using the kernel's three
 * actions:
 *
 * - `continue` — pass the message through unchanged; returning nothing does
 *   the same.
 * - `transform` — replace the text the model receives. Transforms chain in
 *   load order, so a later handler sees the text an earlier one produced. The
 *   user's row keeps the original and the rewrite is recorded at diff level
 *   (`plugin_rewrites`), which is what makes "rewritten by plugin X" visible.
 * - `handled` — keep the message away from the model entirely. Give a
 *   `reason`: it is what the user reads, so a block is never silent.
 *
 * The handler runs with the ordinary 30-second budget; going over it counts as
 * having no opinion (`handler_timeout`).
 */
export type PluginInputResult = {
  action: "continue" | "transform" | "handled";
  text?: string;
  reason?: string;
};

/**
 * The `context` event's payload (ADR 0295 slot 6, permission
 * `runtime.request.before`) — **withdrawn.** The slot was dropped by product
 * decision before shipping: silent rewrites of what the model reads are not
 * offered. A registered handler is accepted silently and never consulted, so
 * `pi.on("context", …)` is dead code.
 *
 * The payload is kept because the published SDK exports the type. The
 * plugin-level route to model-facing AI is `pi.ai.complete`, gated by
 * `agent.model.complete`.
 *
 * @deprecated Withdrawn with ADR 0295 slot 6; the event never fires.
 */
export type PluginContextEvent = {
  type: "context";
  /** The message list the request would carry, in the kernel's message shape. */
  messages: ReadonlyArray<unknown>;
};

/**
 * What a `context` handler would answer. **Withdrawn with the `context` event**
 * (ADR 0295 slot 6): no handler result is consulted, so this shape is kept only
 * because the published SDK exports it.
 *
 * @deprecated Withdrawn with ADR 0295 slot 6; no handler result is read.
 */
export type PluginContextResult = {
  messages?: ReadonlyArray<unknown>;
};

/** One model as the runtime names it: provider id plus model id. */
export type PluginModelRef = {
  provider: string;
  id: string;
};

/**
 * The `model_select` event's payload (ADR 0295 slot 6, permission
 * `runtime.request.before`) — **withdrawn.** The slot was dropped by product
 * decision before shipping: a handler is accepted silently and never
 * consulted, so `pi.on("model_select", …)` is dead code.
 *
 * The payload is kept because the published SDK exports the type. To change
 * the session's binding, use `pi.setModel()` between turns (idle only, the host
 * persists it) — that call is the supported route.
 *
 * @deprecated Withdrawn with ADR 0295 slot 6; the event never fires.
 */
export type PluginModelSelectEvent = {
  type: "model_select";
  /** The model the next provider request would use without an answer here. */
  model: PluginModelRef;
  /**
   * The models the run could put on the request. Kept for compatibility with
   * the exported type; the withdrawn event never asks for an answer, so
   * nothing reads this.
   */
  requestable: ReadonlyArray<PluginModelRef>;
};

/**
 * What a `model_select` handler would answer. **Withdrawn with the
 * `model_select` event** (ADR 0295 slot 6): no handler result is consulted, so
 * the type is kept only because the published SDK exports it. `pi.setModel()`
 * between turns is the supported route to change the session's binding.
 *
 * @deprecated Withdrawn with ADR 0295 slot 6; no handler result is read.
 */
export type PluginModelSelectResult = {
  model: PluginModelRef | string;
};

/**
 * The `thinking_level_select` event's payload (ADR 0295 slot 6, permission
 * `runtime.request.before`) — **withdrawn.** The slot was dropped by product
 * decision before shipping: a handler is accepted silently and never
 * consulted, so `pi.on("thinking_level_select", …)` is dead code.
 *
 * The payload is kept because the published SDK exports the type. The
 * session's thinking level is set through the pi extension API itself
 * (`getThinkingLevel` / `setThinkingLevel`), which the host supports.
 *
 * @deprecated Withdrawn with ADR 0295 slot 6; the event never fires.
 */
export type PluginThinkingLevelSelectEvent = {
  type: "thinking_level_select";
  /** The level the next provider request would use without an answer here. */
  level: string;
  /** The levels this model supports. */
  supported: ReadonlyArray<string>;
};

/**
 * What a `thinking_level_select` handler would answer. **Withdrawn with the
 * `thinking_level_select` event** (ADR 0295 slot 6): no handler result is
 * consulted, so the type is kept only because the published SDK exports it.
 *
 * @deprecated Withdrawn with ADR 0295 slot 6; no handler result is read.
 */
export type PluginThinkingLevelSelectResult = {
  level: string;
};

/**
 * A session lifecycle notice the kernel has no hook for (ADR 0295 slot 11,
 * permission `runtime.session.lifecycle`): the desktop created or deleted a
 * session. Informed-only — nothing can be vetoed, and the delete or create
 * never waits for a handler.
 */
export type PluginSessionLifecycleEvent = {
  type: "session_lifecycle";
  change: "created" | "deleted";
  sessionId: string;
};

/**
 * The kernel's `session_before_switch` (ADR 0295 slot 11), emitted by the
 * desktop when the user leaves a session for a new one or for another session.
 * Informed-only here even though the kernel lets a handler cancel the switch.
 */
export type PluginSessionBeforeSwitchEvent = {
  type: "session_before_switch";
  reason: "new" | "resume";
  sessionId: string;
  targetSessionId?: string;
};

/**
 * The kernel's `session_before_fork` (ADR 0295 slot 11), emitted by the
 * desktop before it forks the session. Informed-only.
 */
export type PluginSessionBeforeForkEvent = {
  type: "session_before_fork";
  sessionId: string;
  entryId?: string;
  position: "before" | "at";
};

/** The conversation a compaction is about to replace (ADR 0295 rule 7). */
export type PluginCompactionSegment = {
  messages: ReadonlyArray<unknown>;
  messageCount: number;
  tokensBefore: number;
  retained: ReadonlyArray<unknown>;
};

/** Payload of `session_before_compact` (ADR 0295 slot 11). */
export type PluginSessionBeforeCompactEvent = {
  type: "session_before_compact";
  reason: "manual" | "threshold" | "overflow";
  retentionMode: "active_turn" | "completed_turn";
  segment: PluginCompactionSegment;
};

export type PluginModelInfo = {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  label: string;
  /** User-configured display alias; the key remains the model identity. */
  alias?: string;
  /** Whether the user enabled this binding for AI-driven delegation. */
  availableForSubagents?: boolean;
  /** The host's default launch model, when it is present in this ready catalog. */
  isDefault?: boolean;
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
  /** `providerId/modelId`; omitted → host default / session-bound model. */
  modelKey?: string;
  thinkingLevel?: string;
  system?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  includeSessionContext?: boolean;
  /** Audit label, e.g. "prompt-enhance". */
  purpose?: string;
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

/**
 * Plugin-level completion on user-configured models (`pi.ai.complete`).
 * Permission: `agent.model.complete` or legacy `agent.complete`.
 * `system` is exactly what the plugin passes — the host does not merge the
 * session system prompt into this side request.
 */
export type PluginAiCompleteInput = PluginCompleteInput & {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

export type PluginAiCompleteResult = PluginCompleteResult;

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
/** One capturable audio endpoint (`audio.capture.background`). */
export type PluginAudioInputDevice = {
  /** Opaque host id; `""` names the system default input. */
  deviceId: string;
  label: string;
  /** The entry the host picks when `deviceId` is omitted. */
  isDefault: boolean;
};

/** A capture the host is holding for this plugin. */
export type PluginAudioCaptureState = {
  active: boolean;
  streamId?: string;
  deviceId?: string;
  label?: string;
  sampleRate?: number;
  channels?: number;
  startedAtMs?: number;
  /** Frames the host dropped because the plugin did not drain its queue in time. */
  droppedFrames: number;
};

/** One PCM frame delivered through `pi.audio.onInputFrame`. */
export type PluginAudioInputFrame = {
  streamId: string;
  /** Monotonic per stream; a gap means dropped frames, not reordered ones. */
  sequence: number;
  timestampMs: number;
  sampleRate: number;
  channels: number;
  format: "pcm16";
  /** Little-endian signed 16-bit samples, interleaved when `channels` is 2. */
  data: Uint8Array;
};

export type PluginAudioOpenInputOptions = {
  /** From `pi.audio.getInputDevices`; omitted means the system default. */
  deviceId?: string;
  sampleRate?: number;
  channels?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

/** An open capture (`pi.audio.openInput`). */
export type PluginAudioInputSession = {
  streamId: string;
  sampleRate: number;
  channels: number;
  deviceId?: string;
  label?: string;
};

export type PluginAudioOpenOutputOptions = {
  sampleRate: number;
  channels?: number;
  format?: "pcm16";
};

/** An open playback queue (`pi.audio.openOutput`). */
export type PluginAudioOutputSession = {
  streamId: string;
  sampleRate: number;
  channels: number;
  format: "pcm16";
};

/** Input for `pi.net.websocket.connect` (`net.websocket`). */
export type PluginWebSocketConnectInput = {
  /** Absolute `ws://` / `wss://` URL; its host must be in `manifest.net.domains`. */
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
  timeoutMs?: number;
};

export type PluginWebSocketOpenEvent = { socketId: string; protocol: string };

export type PluginWebSocketMessageEvent = {
  socketId: string;
  /** Text frames arrive as `string`; binary frames arrive as bytes. */
  data: string | Uint8Array;
};

export type PluginWebSocketCloseEvent = {
  socketId: string;
  code: number;
  reason: string;
  /** False when the connection failed rather than closed cleanly. */
  wasClean: boolean;
};

export type PluginWebSocketErrorEvent = {
  socketId: string;
  code: string;
  message: string;
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

/** Built-in theme preference, or a registered `plugin:<pluginId>:<themeId>` id. */
export type AppThemePreferenceId = "system" | "light" | "dark" | `plugin:${string}`;

/** Runtime theme payload for `pi.themes.upsert`. Sanitized with the load-time rules. */
export type PluginThemeUpsertInput = {
  /** Local theme id (same rules as `contributes.themes[].id`). */
  id: string;
  label: string;
  base: "light" | "dark";
  css: string;
};

/** Lightweight theme row returned by `pi.themes.list`. */
export type PluginThemeSummary = {
  /** Full namespaced id: `plugin:<pluginId>:<themeId>`. */
  id: string;
  themeId: string;
  label: string;
  base: "light" | "dark";
};

export type PluginHostApi = {
  app: {
    getVersion: () => Promise<string>;
    /** Active app language. Plugin-owned UI localizes from this (ADR 0280). */
    getLocale: () => Promise<string>;
    getAppearance: () => Promise<PluginAppearance>;
    /**
     * Apply the host's app theme preference (`ui.theme`). Accepts a built-in
     * preference or a currently registered plugin theme id.
     */
    setTheme: (themeId: AppThemePreferenceId) => Promise<void>;
  };
  /** Runtime theme registry for the calling plugin only (`ui.theme`). */
  themes: {
    upsert: (input: PluginThemeUpsertInput) => Promise<void>;
    remove: (themeId: string) => Promise<void>;
    list: () => Promise<PluginThemeSummary[]>;
    setVariables: (themeId: string, values: Record<string, number | string>) => Promise<void>;
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
  speech: {
    registerAdapter: (adapter: PluginSpeechAdapter) => Promise<void>;
    unregisterAdapter: (protocol: string) => Promise<void>;
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
   * Background microphone capture and streaming playback
   * (`audio.capture.background`, `audio.playback.background`). The host owns
   * the device: plugins exchange PCM frames and never see a device handle.
   */
  audio: {
    getInputDevices: () => Promise<PluginAudioInputDevice[]>;
    openInput: (options?: PluginAudioOpenInputOptions) => Promise<PluginAudioInputSession>;
    closeInput: (streamId: string) => Promise<void>;
    /** Which plugin currently holds an input, if any. */
    getCaptureState: () => Promise<PluginAudioCaptureState>;
    /** Frames arrive at capture pace; a handler that falls behind drops frames. */
    onInputFrame: (handler: (frame: PluginAudioInputFrame) => void) => void;
    offInputFrame: (handler: (frame: PluginAudioInputFrame) => void) => void;
    openOutput: (options: PluginAudioOpenOutputOptions) => Promise<PluginAudioOutputSession>;
    /** Queues PCM16 for playback; rejects when the queue is full. */
    writeOutput: (input: { streamId: string; data: Uint8Array }) => Promise<void>;
    /** Drops queued but unplayed audio — the barge-in primitive. */
    stopOutput: (streamId: string) => Promise<void>;
    closeOutput: (streamId: string) => Promise<void>;
  };
  /** System-wide accelerators, registered and released by the host (`keyboard.globalShortcut`). */
  keyboard: {
    registerGlobalShortcut: (input: {
      id: string;
      accelerator: string;
      command: string;
    }) => Promise<PluginGlobalShortcut>;
    unregisterGlobalShortcut: (id: string) => Promise<void>;
    listGlobalShortcuts: () => Promise<PluginGlobalShortcut[]>;
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
  /** Plugin-level AI on user-configured models. Permission `agent.model.complete`. */
  ai: {
    complete: (input: PluginAiCompleteInput) => Promise<PluginAiCompleteResult>;
    completeStream: (
      input: PluginAiCompleteInput,
      onDelta?: (text: string) => void,
    ) => Promise<PluginAiCompleteResult>;
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
  /**
   * Read-only completed-turn facts served by the host (`usage.read`). Flat
   * counters and identifiers only — no message body, no write path, and no
   * dashboard shape: streaks, heatmaps, and rankings stay the plugin's own
   * computation on top of these rows.
   */
  usage: {
    listTurns: (input?: {
      /** Inclusive window start in epoch ms. Default: `toMs` minus 30 days. */
      fromMs?: number;
      /** Inclusive window end in epoch ms. Default: now. Window span ≤ 365 days. */
      toMs?: number;
      /** Limit rows to one durable project id. */
      projectId?: number | null;
      /** Limit rows to one session id. */
      sessionId?: string;
      /** Opaque page cursor from the previous `nextCursor`. */
      cursor?: string;
      /** 1..=500 rows per page; default 200. */
      limit?: number;
    }) => Promise<PluginUsageTurnPage>;
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
    /**
     * Real-time bidirectional sockets (`net.websocket`). A connect is confined
     * to `manifest.net.domains` exactly like `fetch`, and the host closes every
     * socket the plugin still holds when it unloads.
     */
    websocket: {
      connect: (input: PluginWebSocketConnectInput) => Promise<{ socketId: string }>;
      send: (input: { socketId: string; data: string | Uint8Array }) => Promise<void>;
      close: (input: { socketId: string; code?: number; reason?: string }) => Promise<void>;
    };
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
  /**
   * Optional method host for a renderer slot component's forwarded calls
   * (`plugin.call`, ADR 0294 decision 4). A component that dispatches
   * `plugin.call { method, args }` runs this hook inside its own headless entry
   * — this process — and the renderer receives the return value unchanged.
   *
   * Values are JSON-serializable data: `args` and the answer cross
   * `postMessage`, Electron IPC and a `Result` envelope. `args` is `null` when
   * the caller passed none, and a value the transport cannot carry is refused
   * with `PLUGIN_CALL_UNSERIALIZABLE` rather than arriving truncated. An absent
   * answer arrives at the renderer as `null`; a module that does not implement
   * this hook answers every renderer call with `PLUGIN_CALL_NO_HANDLER`, never
   * `undefined`.
   */
  onRendererCall?: (method: string, args: unknown) => Promise<unknown> | unknown;
};

/** Upper bound on ExtensionAPI modules one plugin may contribute. */
export const MAX_AGENT_EXTENSIONS_PER_PLUGIN = 8;
/** Upper bound on system-wide accelerators one plugin may declare. */
export const MAX_GLOBAL_SHORTCUTS_PER_PLUGIN = 8;

export const PLUGIN_PERMISSIONS = [
  "ui.panel",
  "ui.view",
  "ui.microphone",
  "ui.theme",
  "ui.settings",
  "ui.window.appearance",
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
  // Trusted renderer host (spec 07-plugins/16). One name covers every component
  // slot: slots are authorized by trust tier, never one by one.
  "renderer.extension",
  "provider.register",
  "desktop.control",
  "models.list",
  "project.create",
  "session.read",
  "session.import",
  "session.read.own",
  "session.update.own",
  "session.delete.own",
  // Read-only usage facts (pi.usage.listTurns):
  // completed-turn counters and session titles, never message bodies.
  "usage.read",
  "net.fetch",
  "shell.openExternal",
  "mcp.server.local",
  "mcp.server.remote",
  "background.service",
  "bus.publish",
  "bus.subscribe",
  "browser.cdp",
  // Background device access. `ui.microphone` stays panel-scoped: these two are
  // what a service may use with no page open.
  "audio.capture.background",
  "audio.playback.background",
  "speech.adapter.register",
  "keyboard.globalShortcut",
  "net.websocket",
  // Runtime slots (#561). Slot 6 (`runtime.request.before`) is withdrawn by
  // product decision — silent request rewrites are not offered. The twelfth
  // (`runtime.approval.before`) is not built. `agent.model.complete` gates
  // plugin-side completion on user-configured models (`pi.ai.complete`).
  "agent.model.complete",
  "runtime.send.before",
  "runtime.session.lifecycle",
  "runtime.session.read",
  "runtime.tool.extend",
  "runtime.tool.gate",
  "runtime.turn.abort",
  "runtime.turn.closing",
  "runtime.turn.continue",
  "runtime.turn.facts",
  "runtime.turn.recap",
  "runtime.turn.watch",
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
  if (m.main !== undefined) {
    if (typeof m.main !== "string" || !m.main) {
      return { ok: false, error: "manifest.main must be a non-empty string" };
    }
    const mainError = relativePathError(m.main, "manifest.main");
    if (mainError) return { ok: false, error: mainError };
  }
  if (m.renderer !== undefined) {
    if (typeof m.renderer !== "string" || !m.renderer) {
      return { ok: false, error: "manifest.renderer must be a non-empty string" };
    }
    const rendererError = relativePathError(m.renderer, "manifest.renderer");
    if (rendererError) return { ok: false, error: rendererError };
  }
  // Both vocabularies are host-owned, so a name outside them is an authoring
  // mistake worth catching at install rather than at the first refused call.
  const rendererDataError = rendererVocabularyError(
    m.rendererData,
    "rendererData",
    PLUGIN_RENDERER_DATA,
  );
  if (rendererDataError) return { ok: false, error: rendererDataError };
  const rendererActionsError = rendererVocabularyError(
    m.rendererActions,
    "rendererActions",
    PLUGIN_RENDERER_ACTIONS,
  );
  if (rendererActionsError) return { ok: false, error: rendererActionsError };
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
  const i18nError = manifestI18nError((m as Record<string, unknown>).i18n);
  if (i18nError) return { ok: false, error: i18nError };
  const ui = m.ui as
    | {
        title?: unknown;
        panel?: unknown;
        shape?: unknown;
        alwaysOnTop?: unknown;
        resizable?: unknown;
      }
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
    if (ui.shape !== undefined && ui.shape !== "panel" && ui.shape !== "widget") {
      return { ok: false, error: "manifest.ui.shape must be \"panel\" or \"widget\"" };
    }
    for (const key of ["alwaysOnTop", "resizable"] as const) {
      const value = ui[key];
      if (value !== undefined && typeof value !== "boolean") {
        return { ok: false, error: `manifest.ui.${key} must be a boolean` };
      }
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
  if (
    !contributesError &&
    (m.contributes?.providers?.length ?? 0) > 0 &&
    !(m.permissions ?? []).includes("provider.register")
  ) {
    return { ok: false, error: "contributes.providers requires the provider.register permission" };
  }
  if (
    !contributesError &&
    m.contributes?.windowAppearance !== undefined &&
    !(m.permissions ?? []).includes("ui.window.appearance")
  ) {
    return {
      ok: false,
      error: "contributes.windowAppearance requires the ui.window.appearance permission",
    };
  }
  if (
    !contributesError &&
    (m.contributes?.globalShortcuts?.length ?? 0) > 0 &&
    !(m.permissions ?? []).includes("keyboard.globalShortcut")
  ) {
    return {
      ok: false,
      error: "contributes.globalShortcuts requires the keyboard.globalShortcut permission",
    };
  }
  if (contributesError) {
    return { ok: false, error: contributesError };
  }

  // Relaxing `main` must not produce a plugin that cannot run at all: one of
  // the three entries still has to exist (spec 07-plugins/02).
  if (!pluginHasEntry(m)) {
    return {
      ok: false,
      error: "manifest needs one of main, renderer, or a plugin page",
    };
  }
  // The renderer entry is the trusted tier: it runs in the host renderer, so
  // declaring it is not enough — the grant has to be requested too.
  if (m.renderer !== undefined && !(m.permissions ?? []).includes("renderer.extension")) {
    return {
      ok: false,
      error: "manifest.renderer requires the renderer.extension permission",
    };
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

/** Names of the four places a manifest can hang behaviour off. */
export type PluginManifestEntryFlags = {
  /** `manifest.main`: a headless module in the plugin's own process. */
  main: boolean;
  /** `manifest.renderer`: trusted component slots inside the app window. */
  renderer: boolean;
  /** A plugin-owned page: `ui.panel` or a view. */
  page: boolean;
  /** `contributes.agentExtensions`: modules in the agent process. */
  agent: boolean;
};

/**
 * Which entries a manifest declares. The three tiers in spec 07-plugins/16
 * follow from this: `renderer` is what puts plugin code in the app window and
 * `agent` is what puts it in the agent process.
 */
export function manifestEntries(
  manifest: Pick<PluginManifest, "main" | "renderer" | "ui" | "contributes">,
): PluginManifestEntryFlags {
  const hasText = (value: unknown): boolean =>
    typeof value === "string" && value.trim().length > 0;
  return {
    main: hasText(manifest.main),
    renderer: hasText(manifest.renderer),
    page:
      hasText(manifest.ui?.panel) ||
      (manifest.contributes?.views?.length ?? 0) > 0,
    agent: (manifest.contributes?.agentExtensions?.length ?? 0) > 0,
  };
}

/**
 * A plugin is reachable through one of three entries: the headless module
 * (`main`), the trusted renderer module (`renderer`), or a plugin-owned page.
 * Contributions that are not entries — agent extensions, services, providers,
 * themes — do not make a plugin runnable on their own.
 */
export function pluginHasEntry(
  manifest: Pick<PluginManifest, "main" | "renderer" | "ui" | "contributes">,
): boolean {
  const entries = manifestEntries(manifest);
  return entries.main || entries.renderer || entries.page;
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
  const shortcuts = contributes.globalShortcuts ?? [];
  if (!Array.isArray(shortcuts)) return "contributes.globalShortcuts must be an array";
  if (shortcuts.length > MAX_GLOBAL_SHORTCUTS_PER_PLUGIN) {
    return `contributes.globalShortcuts is limited to ${MAX_GLOBAL_SHORTCUTS_PER_PLUGIN} entries`;
  }
  const shortcutIds = new Set<string>();
  for (const shortcut of shortcuts) {
    if (!shortcut || typeof shortcut !== "object") {
      return "contributes.globalShortcuts entries must be objects";
    }
    if (
      typeof shortcut.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(shortcut.id)
    ) {
      return "contributes.globalShortcuts entries need an id matching [a-zA-Z][a-zA-Z0-9._-]{0,63}";
    }
    if (shortcutIds.has(shortcut.id)) {
      return `duplicate global shortcut id "${shortcut.id}"`;
    }
    shortcutIds.add(shortcut.id);
    if (typeof shortcut.command !== "string" || !shortcut.command.trim()) {
      return `global shortcut "${shortcut.id}" requires a command`;
    }
    // A shortcut may only reach its own plugin's commands, so the command has
    // to exist here rather than be resolved later against the whole registry.
    if (!commandIds.has(shortcut.command)) {
      return `global shortcut "${shortcut.id}" references an undeclared command`;
    }
    if (shortcut.default !== undefined && !isValidShortcutShape(shortcut.default)) {
      return `global shortcut "${shortcut.id}" has an invalid default`;
    }
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

  const declaredProviders = contributes.providers ?? [];
  if (!Array.isArray(declaredProviders)) return "contributes.providers must be an array";
  if (declaredProviders.length > MAX_PLUGIN_PROVIDERS_PER_PLUGIN) {
    return `contributes.providers allows at most ${MAX_PLUGIN_PROVIDERS_PER_PLUGIN} entries`;
  }
  const providerIds = new Set<string>();
  for (const provider of declaredProviders) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      return "contributes.providers entries must be objects";
    }
    if (typeof provider.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(provider.id)) {
      return "provider declaration id is missing or invalid";
    }
    if (providerIds.has(provider.id)) {
      return `duplicate provider declaration id "${provider.id}"`;
    }
    providerIds.add(provider.id);
    if (typeof provider.name !== "string" || !provider.name.trim()) {
      return `provider "${provider.id}" requires a name`;
    }
    if (
      provider.vendorKey !== undefined &&
      (typeof provider.vendorKey !== "string" || !provider.vendorKey.trim())
    ) {
      return `provider "${provider.id}" vendorKey must be a non-empty string`;
    }
    if (provider.baseUrl !== undefined) {
      if (typeof provider.baseUrl !== "string") {
        return `provider "${provider.id}" baseUrl must be a string`;
      }
      // The runtime reaches this endpoint, so only an absolute http(s) URL
      // may be declared.
      if (!(provider.baseUrl.startsWith("http://") || provider.baseUrl.startsWith("https://"))) {
        return `provider "${provider.id}" baseUrl must be an http(s) URL`;
      }
    }
    if (provider.apiStyle !== undefined) {
      if (typeof provider.apiStyle !== "string") {
        return `provider "${provider.id}" apiStyle must be a string`;
      }
      if (!(PLUGIN_PROVIDER_API_STYLES as readonly string[]).includes(provider.apiStyle)) {
        return `provider "${provider.id}" has unsupported apiStyle ${provider.apiStyle}`;
      }
    }
    if (provider.authKind !== undefined) {
      if (typeof provider.authKind !== "string") {
        return `provider "${provider.id}" authKind must be a string`;
      }
      if (!(PLUGIN_PROVIDER_AUTH_KINDS as readonly string[]).includes(provider.authKind)) {
        return `provider "${provider.id}" has unsupported authKind ${provider.authKind}`;
      }
    }
    // A Host-owned plugin login flow does not exist yet, so a declaration that
    // asks for one is refused rather than turned into a row nobody can sign in
    // to.
    if ((provider as { oauth?: unknown }).oauth !== undefined) {
      return `provider "${provider.id}" declares oauth; plugin OAuth providers are not supported in this release`;
    }
    if (!Array.isArray(provider.models)) {
      return `provider "${provider.id}" requires models`;
    }
    if (provider.models.length === 0 || provider.models.length > MAX_PLUGIN_PROVIDER_MODELS) {
      return `provider "${provider.id}" declares 1 to ${MAX_PLUGIN_PROVIDER_MODELS} models`;
    }
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (!model || typeof model !== "object" || Array.isArray(model)) {
        return `provider "${provider.id}" model entries must be objects`;
      }
      const modelId = typeof model.id === "string" ? model.id.trim() : "";
      if (!modelId || modelId.length > 256) {
        return `provider "${provider.id}" has a model without a valid id`;
      }
      if (modelIds.has(modelId)) {
        return `provider "${provider.id}" declares model ${modelId} twice`;
      }
      modelIds.add(modelId);
      if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim())) {
        return `provider "${provider.id}" model ${modelId} name must be a non-empty string`;
      }
      for (const field of ["contextWindow", "maxTokens"] as const) {
        const value = model[field];
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
          return `provider "${provider.id}" model ${modelId} ${field} must be a positive integer`;
        }
      }
      if (model.supportsImages !== undefined && typeof model.supportsImages !== "boolean") {
        return `provider "${provider.id}" model ${modelId} supportsImages must be a boolean`;
      }
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
    if (theme.assets !== undefined) {
      if (!Array.isArray(theme.assets)) {
        return `theme "${theme.id}" assets must be an array`;
      }
      const assetPaths = new Set<string>();
      for (const asset of theme.assets) {
        if (typeof asset !== "string" || !isThemeAssetPath(asset)) {
          return `theme "${theme.id}" asset must be a package-relative or absolute ${THEME_ASSET_EXTENSIONS.join(
            "/",
          )} path`;
        }
        // `bg.png` and `./bg.png` are one asset, so compare the normalized form.
        const normalized = normalizeThemeAssetPath(asset);
        if (assetPaths.has(normalized)) {
          return `theme "${theme.id}" declares "${asset}" twice`;
        }
        assetPaths.add(normalized);
      }
    }
    if (theme.variables !== undefined) {
      if (!Array.isArray(theme.variables)) return `theme "${theme.id}" variables must be an array`;
      const variables = new Set<string>();
      for (const variable of theme.variables) {
        if (!validatePluginThemeVariableDeclaration(variable)) {
          return `theme "${theme.id}" has an invalid variable declaration`;
        }
        if (variables.has(variable.name)) return `theme "${theme.id}" declares variable "${variable.name}" twice`;
        variables.add(variable.name);
      }
    }
  }

  const scenicThemes = contributes.scenicThemes;
  if (scenicThemes !== undefined) {
    if (!scenicThemes || typeof scenicThemes !== "object" || Array.isArray(scenicThemes)) return "contributes.scenicThemes must be an object";
    if (typeof scenicThemes.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(scenicThemes.id)) return "contributes.scenicThemes id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    const localized = (value: unknown) => Boolean(value && typeof value === "object" && typeof (value as PluginLocalizedString).en === "string" && typeof (value as PluginLocalizedString)["zh-CN"] === "string");
    if (!localized(scenicThemes.label)) return "contributes.scenicThemes requires a localized label";
    if (!localized(scenicThemes.description)) return "contributes.scenicThemes requires a localized description";
    if (scenicThemes.keywords !== undefined && (!Array.isArray(scenicThemes.keywords) || !scenicThemes.keywords.every(localized))) return "contributes.scenicThemes keywords must be localized";
    if (scenicThemes.icon !== "palette") return "contributes.scenicThemes has an unsupported icon";
    if (!Array.isArray(scenicThemes.themes) || scenicThemes.themes.length < 1 || scenicThemes.themes.length > 12) return "contributes.scenicThemes themes must contain 1 to 12 cards";
    const themeIds = new Set<string>();
    for (const card of scenicThemes.themes) {
      if (!card || typeof card !== "object") return "contributes.scenicThemes theme cards must be objects";
      if (typeof card.themeId !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(card.themeId)) return "contributes.scenicThemes card themeId must be valid";
      if (themeIds.has(card.themeId)) return `contributes.scenicThemes duplicates themeId "${card.themeId}"`;
      themeIds.add(card.themeId);
      if (!localized(card.label)) return "contributes.scenicThemes card requires a localized label";
      if (!localized(card.description)) return "contributes.scenicThemes card requires a localized description";
      if (typeof card.previewAsset !== "string" || !isThemeAssetPath(card.previewAsset)) return "contributes.scenicThemes card previewAsset must be an image path";
    }
  }

  const windowAppearance = contributes.windowAppearance;
  if (windowAppearance !== undefined) {
    if (
      typeof windowAppearance !== "object" ||
      windowAppearance === null ||
      Array.isArray(windowAppearance)
    ) {
      return "contributes.windowAppearance must be an object";
    }
    const backgroundColor = windowAppearance.backgroundColor;
    if (backgroundColor !== undefined) {
      if (
        typeof backgroundColor !== "object" ||
        backgroundColor === null ||
        Array.isArray(backgroundColor)
      ) {
        return "contributes.windowAppearance.backgroundColor must be an object";
      }
      for (const key of ["light", "dark"] as const) {
        const value = backgroundColor[key];
        if (value === undefined) continue;
        if (typeof value !== "string" || !WINDOW_BACKGROUND_COLOR_PATTERN.test(value)) {
          return `contributes.windowAppearance.backgroundColor.${key} must be #rrggbb or #rrggbbaa`;
        }
      }
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

/**
 * `manifest.i18n` is display metadata: locale id → the strings that locale
 * shows. Shape errors are refused because a malformed block would silently
 * leave the shell on the author's own language with no way to tell why; a
 * locale or field a plugin does not translate is fine and falls back.
 */
function manifestI18nError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "manifest.i18n must be an object of locale → { name?, description?, safetyNotes? }";
  }
  for (const [locale, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `manifest.i18n.${locale} must be an object`;
    }
    for (const field of ["name", "description", "safetyNotes"] as const) {
      const text = (entry as Record<string, unknown>)[field];
      if (text !== undefined && typeof text !== "string") {
        return `manifest.i18n.${locale}.${field} must be a string`;
      }
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

/**
 * Shape check for one of the two renderer vocabularies (`rendererData`,
 * `rendererActions`). The names are host-owned, so an entry outside the
 * vocabulary is refused rather than kept as a string nobody will ever read.
 * Absent is valid: a plugin that declares nothing reads nothing.
 */
function rendererVocabularyError(
  value: unknown,
  field: string,
  vocabulary: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `manifest.${field} must be an array`;
  // Every allowed name is worth at most one entry, so a longer list cannot be
  // satisfied however it is written.
  if (value.length > vocabulary.length) {
    return `manifest.${field} allows at most ${vocabulary.length} entries, got ${value.length}`;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      return `manifest.${field} entry ${JSON.stringify(entry)} is not a non-empty string`;
    }
    if (!vocabulary.includes(entry)) {
      return `manifest.${field} has an unknown entry "${entry}"`;
    }
    if (seen.has(entry)) return `manifest.${field} declares "${entry}" twice`;
    seen.add(entry);
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
  findThemeCssUrlReferences,
  isExternalThemeAssetPath,
  isThemeAssetPath,
  maskNonCodeCss,
  normalizeThemeAssetPath,
  sanitizeThemeCss,
  themeAssetUrl,
  THEME_ASSET_EXTENSIONS,
  THEME_ASSET_MAX_BYTES,
  THEME_ASSET_SCHEME,
  THEME_CSS_MAX_BYTES,
  type ThemeCssAssetResolver,
  type ThemeCssResult,
  type ThemeCssUrlReference,
} from "./theme-css.js";
export {
  formatPluginThemeVariables,
  isPluginThemeVariableName,
  normalizePluginThemeVariableValues,
  validatePluginThemeVariableDeclaration,
  validatePluginThemeVariables,
  type PluginThemeVariableContrib,
  type PluginThemeVariableValues,
} from "./theme-variables.js";
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
  isNetSocketUrlAllowed,
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

export {
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_RENDERER_AMBIENT_DATA,
  PLUGIN_RENDERER_COMPOSER_DEFAULT_POSITIONS,
  PLUGIN_RENDERER_COMPOSER_POSITIONS,
  PLUGIN_RENDERER_DATA,
  PLUGIN_RENDERER_REPLACE_SLOTS,
  PLUGIN_RENDERER_SCHEME,
  PLUGIN_RENDERER_SLOTS,
  PLUGIN_RENDERER_UNSERVED_DATA,
  PLUGIN_SLOT_DESIGN_TOKENS,
  PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS,
  isPluginRendererReplaceSlot,
  scopePluginStyle,
  type PiRendererAmbientProps,
  type PiRendererApi,
  type PiRendererCodeBlockProps,
  type PiRendererCompletionSourceProps,
  type PiRendererComponent,
  type PiRendererComposerContextUsage,
  type PiRendererComposerControlPosition,
  type PiRendererComposerControlProps,
  type PiRendererComposerEnhancement,
  type PiRendererComposerModelSelection,
  type PiRendererComposerReference,
  type PiRendererComposerReferenceProps,
  type PiRendererDispatch,
  type PiRendererEntryAction,
  type PiRendererEntryAttachment,
  type PiRendererEntryExtraProps,
  type PiRendererEntryIdentity,
  type PiRendererEntryMessage,
  type PiRendererEntryProps,
  type PiRendererFunctionCallResult,
  type PiRendererFunctionFailureCode,
  type PiRendererFunctionHandle,
  type PiRendererHostFunction,
  type PiRendererInlineConfirmProps,
  type PiRendererInlineConfirmRequest,
  type PiRendererModule,
  type PiRendererNode,
  type PiRendererReferenceSendInput,
  type PiRendererRegistration,
  type PiRendererSlotOptions,
  type PiRendererStyleHandle,
  type PiRendererToolCall,
  type PiRendererToolCardProps,
  type PluginRendererActionName,
  type PluginRendererAmbientDataKey,
  type PluginRendererDataKey,
  type PluginRendererSlot,
  type PluginRendererSlotDiagnosticCode,
  type PluginSlotDesignToken,
} from "./renderer.js";
