/** Shared public types grouped by the owning application domain. */
import type { ActivationScope } from "../activation.js";
import type { TrustedExtensionDiagnostic } from "../trusted-extensions.js";

export type PluginMarketSource = "official" | "mirror" | "custom";

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
  | "agentExtension";

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
  source: "installed" | "dev" | "marketplace";
  status: "ready" | "error" | "disabled" | "load_error";
  errorMessage?: string;
  permissions: string[];
  path?: string;
  /** Derived from the manifest by the host: which contribution kinds exist. */
  capabilities?: PluginCapability[];
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
  diagnostics: TrustedExtensionDiagnostic[];
};
