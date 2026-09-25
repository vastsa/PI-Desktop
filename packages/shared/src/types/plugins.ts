/** Shared public types grouped by the owning application domain. */
import type { ActivationScope } from "../activation.js";
import type { TrustedExtensionDiagnostic } from "../trusted-extensions.js";

/**
 * Where the marketplace catalog comes from.
 *
 * `official` keeps its meaning — the official one — and the official one is the
 * plugin center, so a settings row written before the center existed keeps
 * meaning what its author picked instead of needing a migration. `github` and
 * `mirror` are the two backup channels, and `custom` is a URL the user typed.
 */
export type PluginMarketSource = "official" | "github" | "mirror" | "custom";

export type PluginUpdateInfo = {
  version: string;
  changelog?: string;
  shasum: string;
  url: string;
  permissionDiff?: string[];
};

/**
 * Trust tier the host is willing to render for a catalog entry.
 *
 * Issued by the plugin center, never asserted by a publisher: the host
 * downgrades a `verified` claim from any source other than the configured
 * official one, and renders an unrecognised tier as `unknown` (ADR 0102).
 */
export type MarketTrust = "verified" | "community" | "unknown";

/**
 * Source pin recorded for a published version.
 *
 * Evidence for a human decision before install, not an integrity control — it
 * is only as trustworthy as the catalog it came from, and the checksum stays
 * the mechanism that decides whether bytes are accepted.
 */
export type MarketProvenance = {
  /** Canonical https URL of the publisher's own repository. */
  sourceRepository: string;
  /** `refs/tags/<tag>` or a 40-hex commit, as submitted. */
  sourceRef?: string;
  /** Resolved 40-hex commit the artifact was built from. */
  sourceCommit?: string;
  /** Plugin directory inside that repository. */
  sourcePath?: string;
  builder?: string;
  builtAt?: string;
};

/** Publish verdict issued by the center's policy evaluator. */
export type MarketReview = {
  decision?: string;
  risk?: string;
  policyVersion?: string;
  reviewedAt?: string;
};

/** Distribution-side withdrawal of the exact version installed here. */
export type PluginYankNotice = {
  version: string;
  reason?: string;
};

export type PluginMarketplaceMeta = {
  providerId: string;
  shasum?: string;
  publisherId?: string;
  /** Trust tier accepted at install time, kept for later display. */
  trust?: MarketTrust;
  /** Source pin of the installed version, when the catalog carried one. */
  provenance?: MarketProvenance;
};

export type PluginUiMeta = {
  panel?: string;
  width?: number;
  height?: number;
  title?: string | PluginLocalizedString;
  /**
   * Panel placement. `"panel"` (default) keeps the host-owned 46px drag band
   * and its three-control capsule. `"widget"` is a transparent, frameless
   * floating surface with neither, sized from the inside: the page owns its
   * whole rectangle and drags the window through a host-provided drag map.
   */
  shape?: "panel" | "widget";
  /** Floating widget placement only: keep the surface above other windows. */
  alwaysOnTop?: boolean;
  /** Overrides the per-shape default: panels are resizable, widgets are not. */
  resizable?: boolean;
};


/**
 * A development plugin waiting for its permission review.
 *
 * Choosing a folder is a request, not consent: the host answers with what the
 * folder declares and loads nothing until the user accepts it. `kind` is
 * `"load"` for a folder or scaffold that is not registered yet, and `"reload"`
 * for a plugin already loaded whose manifest now asks for more than the
 * approval it is running under.
 */
export type PluginPermissionReview = {
  kind: "load" | "reload";
  /** Absolute path of the plugin folder being reviewed. */
  path: string;
  id: string;
  name: string;
  version?: string;
  /** Every permission the manifest declares. */
  permissions: string[];
  /**
   * What is beyond the current approval: new permission names, and widened file
   * scopes rendered as `fs.<mode>…` entries. Empty for a first load.
   */
  addedPermissions: string[];
};
/**
 * One plugin-contributed work panel view, resolved for the current window.
 *
 * The renderer never reads a manifest: the main process resolves the localized
 * title against the active locale, filters by permission, activation scope, and
 * entry existence, and hands over only what the panel menu has to draw. `icon`
 * is a token from the SDK's closed list, not plugin markup.
 */
export type PluginViewMeta = {
  pluginId: string;
  /** Plugin-local view id from `contributes.views[].id`. */
  viewId: string;
  /** `<pluginId>/<viewId>` — the work panel tab's resource string. */
  ref: string;
  /** Already resolved against the host locale. */
  title: string;
  /** Owning plugin's display name, for tooltips and disambiguation. */
  pluginName: string;
  icon?: string;
  order: number;
};

/** A data-only scenic Settings destination rendered by the host React tree. */
export type PluginScenicThemesDestinationMeta = {
  pluginId: string;
  destinationId: string;
  ref: string;
  label: string;
  description: string;
  pluginName: string;
  icon: "palette";
  keywords: string[];
  themes: PluginScenicThemeCardMeta[];
};

/** One host-validated preview card belonging to a scenic destination. */
export type PluginScenicThemeCardMeta = {
  themeId: string;
  label: string;
  description: string;
  previewUrl: string;
  blur: number;
  blurDefault: number;
};

/**
 * Which files one file mode may touch, straight from `manifest.fs`. Declared
 * here rather than imported from the plugin SDK because this package sits under
 * it: the SDK owns the matching and the host owns the enforcement, while this is
 * only the shape that reaches the UI so a user can see what they granted.
 */
export type PluginFsRule = {
  /** `workspace` unless the plugin asks the user to point at a directory. */
  root?: "workspace" | "userSelected";
  /** Globs relative to the root. Empty means "nothing without confirmation". */
  scope?: string[];
  /** Delete only: files the plugin wrote itself, which need no scope. */
  own?: boolean;
};

export type PluginFsPolicy = {
  read?: PluginFsRule;
  write?: PluginFsRule;
  delete?: PluginFsRule;
};

/** Localized plugin labels match the desktop shell's supported locales. */
export type PluginLocalizedString = {
  en: string;
  "zh-CN": string;
};

export type PluginCapability =
  | "panel"
  | "views"
  | "commands"
  | "tools"
  | "skills"
  | "themes"
  | "mcp"
  | "services"
  | "bus"
  /** `contributes.agentExtensions`: ExtensionAPI modules in the agent process. */
  | "agentExtension"
  /** `manifest.renderer`: the plugin ships a renderer slot entry (`docs/plugin-plan/ui/`). */
  | "rendererUi";

/**
 * A loaded plugin's renderer extension as the renderer host sees it
 * (`docs/plugin-plan/ui/`). The main process builds it from the live load, so
 * it never outlives the plugin: unload, crash, or a revoked permission drops
 * it from the next plugin list.
 */
export type PluginRendererDescriptor = {
  /** Renderer module path relative to the plugin root. */
  entry: string;
  /**
   * Load generation. Every load of the plugin gets a new one, and module URLs
   * carry it (`plugin-renderer://<id>/g<generation>/<entry>`), so a reload
   * evaluates fresh modules instead of the ES module cache's stale copy and a
   * stale generation is refused outright.
   */
  generation: number;
  /** `manifest.rendererActions`: the outbound actions dispatch accepts. */
  actions: string[];
  /** `manifest.rendererCallMethods`: the `plugin.call` method whitelist. */
  callMethods: string[];
  /**
   * Bare `contributes.agentTools[].name`s. A `toolCard` registration must
   * name one of these; the card then serves only that tool's calls.
   */
  tools: string[];
};

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

/** Declarative setting rendered by the installed-plugin settings surface. */
export type PluginSettingDefinition = {
  key: string;
  title: string;
  description?: string;
  type: PluginSettingType;
  default?: unknown;
  enum?: PluginSettingOption[];
  /** Shortcut settings invoke this plugin command in the app window. */
  command?: string;
  /** The first shortcut scope; global registration is intentionally not supported. */
  scope?: "plugin";
  /** Resolved private value, returned only to the owning plugin settings UI. */
  value?: unknown;
};

/** A theme contributed by a loaded plugin, with its sanitized CSS payload. */
export type PluginTheme = {
  /** `plugin:<pluginId>:<themeId>`; matches `AppSettings.theme`. */
  id: `plugin:${string}`;
  pluginId: string;
  themeId: string;
  label: string;
  /** Palette the overrides layer on; drives the `data-theme` attribute. */
  base: "light" | "dark";
  css: string;
  /** Host-generated, manifest-validated variable layer for this theme only. */
  variablesCss?: string;
  /**
   * Native window background for this theme, per resolved palette, as
   * `#rrggbb` or `#rrggbbaa`. Absent unless the providing plugin declared it
   * and holds `ui.window.appearance` (ADR 0248).
   */
  windowBackground?: { light?: string; dark?: string };
};

export type PluginServiceState = "starting" | "running" | "stopped" | "failed";

/** Supervision state of one resident plugin service (spec 07 §5). */
export type PluginServiceStatus = {
  pluginId: string;
  serviceId: string;
  label: string;
  state: PluginServiceState;
  /** Host-process restarts this service survived since it was last started. */
  restarts: number;
  /** Why the service is `failed`. */
  message?: string;
  updatedAt: number;
};

export type PluginSummary = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /** Where the plugin is allowed to run; absent records predate scopes. */
  scope?: ActivationScope;
  source: "builtin" | "installed" | "dev" | "marketplace";
  /**
   * True while this application build ships the plugin from
   * `resources/plugins`. A bundled plugin cannot be uninstalled, but it can be
   * updated, and this flag follows that update (ADR 0241).
   */
  bundled?: boolean;
  status: "ready" | "error" | "disabled" | "load_error";
  errorMessage?: string;
  permissions: string[];
  path?: string;
  /** Derived from the manifest by the host: which contribution kinds exist. */
  capabilities?: PluginCapability[];
  /**
   * Present only while the plugin is loaded, holds `renderer.extension`, and
   * declares `manifest.renderer`: everything the renderer host needs to load
   * the plugin's slot module and gate what it registers and dispatches.
   */
  renderer?: PluginRendererDescriptor;
  description?: string;
  author?: string;
  installedAt?: string;
  updatedAt?: string;
  marketplace?: PluginMarketplaceMeta;
  autoUpdate?: boolean;
  updateAvailable?: PluginUpdateInfo;
  /**
   * Set when the catalog withdrew the exact version installed here. The host
   * surfaces it and leaves the plugin running; withdrawal is a distribution
   * signal, not consent to disable working software.
   */
  yanked?: PluginYankNotice;
  ui?: PluginUiMeta;
  /** Declared file scope, so the page can show it next to the permissions. */
  fs?: PluginFsPolicy;
  settings?: PluginSettingDefinition[];
  /** Live state of the plugin's `contributes.agentExtensions` modules, from
   * the most recent session that loaded them (spec 07-plugins/16 §11). */
  agentExtension?: PluginAgentExtensionStatus;
};

/** What the agent process reported for one plugin's ExtensionAPI modules. */
export type PluginAgentExtensionStatus = {
  /** `enabled` until a session loads the modules in this app run. */
  state: "enabled" | "loaded" | "error";
  toolNames: string[];
  commandNames: string[];
  /** Custom agents the modules registered through `registerAgent` /
   * `registerProvider` (spec 07-plugins/16 §5). */
  agentNames: string[];
  diagnostics: TrustedExtensionDiagnostic[];
};

/**
 * One folder root of the active project, as a plugin sees it (ADR 0263).
 *
 * A project may be a logical group of several local folders (ADR 0249), and
 * only the primary root is the workspace the agent's tools default to. The flag
 * is what tells a plugin which root the relative paths it is handed belong to.
 */
export type PluginWorkspaceRoot = {
  path: string;
  name: string;
  /** The group's primary root — the one the visible workspace resolves to. */
  primary: boolean;
};

/**
 * The workspace a plugin is told about: the primary root plus the other folders
 * of the same project group. Additive over the original `{ path, name }`, so a
 * plugin that ignores `projectId` and `roots` behaves exactly as before, and a
 * host that cannot resolve a group simply omits both.
 */
export type PluginWorkspaceInfo = {
  path: string;
  name: string;
  /** Stable id of the project group this workspace belongs to. */
  projectId?: string;
  /** Every registered folder of that group, primary first. */
  roots?: PluginWorkspaceRoot[];
};

/** One mirror an install tried, and what it answered. */
export type PluginInstallMirror = {
  source: string;
  url: string;
  error?: string | null;
};

/**
 * What an install is doing, reported while it runs.
 *
 * The install is a single request, so without these the interface has nothing
 * to show between the click and the answer. `error` is set on the report that
 * ends a failed install; `receivedBytes`/`totalBytes` are a progress pair and
 * `totalBytes` is 0 when nothing announced a size.
 */
export type PluginInstallProgress = {
  pluginId: string;
  version: string;
  phase: "resolve" | "download" | "verify" | "install" | "enable";
  source?: string | null;
  attempt?: number;
  attempts?: number;
  receivedBytes?: number;
  totalBytes?: number;
  tried?: PluginInstallMirror[];
  error?: string | null;
};
