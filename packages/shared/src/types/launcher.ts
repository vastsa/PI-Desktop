/**
 * Shared contract for the plugin launcher surface (`Alt+Space`).
 *
 * The launcher is its own renderer surface backed by one browser window, so the
 * main process owns every authoritative fact here: which plugins are launchable,
 * which OS applications the machine actually has, and what a click is allowed to
 * open. The renderer receives *display and matching* metadata and an opaque
 * item id — never an executable path, so it can only ask the host to launch an
 * item the host itself discovered (docs/spec/07-plugins/17-plugin-launcher.md).
 */

/** What a launcher tile opens. */
export type LauncherItemKind = "plugin" | "app";

/**
 * Why the launcher surfaced an item. Rendered as the tile's second line so the
 * user learns how they matched instead of guessing.
 */
export type LauncherMatchReason =
  | "name"
  | "pinyin"
  | "initials"
  | "alias"
  | "description"
  | "pattern"
  | "pinned"
  | "recent";

/** Where a discovered application came from, shown as its source tag. */
export type LauncherAppSource = "start-menu" | "app-bundle" | "desktop-entry";

/**
 * One regex a plugin declares in `contributes.launcherTriggers`.
 *
 * `pattern` is matched against the *whole* trimmed launcher input, so a plugin
 * that declares an arithmetic character class never competes with a
 * one-character query. The host validates the pattern at manifest load and
 * refuses constructs that can backtrack catastrophically (a nested quantifier
 * such as a repeated group over a repeated atom), so a bad declaration cannot
 * freeze the panel.
 */
export type LauncherTriggerMeta = {
  id: string;
  pattern: string;
  /** Declared flags, already filtered to `i` / `s` / `m` / `u`. */
  flags?: string;
  /** Author-facing label; resolved against the active locale by the host. */
  title?: string;
};

/** A launchable plugin as the launcher sees it. */
export type LauncherPluginEntry = {
  kind: "plugin";
  /** Opaque item id: `plugin:<pluginId>`. */
  id: string;
  pluginId: string;
  name: string;
  description?: string;
  /** Declared triggers that survived manifest validation. */
  triggers: LauncherTriggerMeta[];
};

/**
 * An installed application as the launcher sees it.
 *
 * Deliberately carries no path: `id` is resolved against the host's own scan
 * result when the user opens the tile, so a compromised renderer cannot use the
 * launcher to start an arbitrary program.
 */
export type LauncherAppEntry = {
  kind: "app";
  /** Opaque item id: `app:<stableKey>`. */
  id: string;
  name: string;
  /** Executable file name without extension, for the tile's source tag. */
  executableName?: string;
  source: LauncherAppSource;
  /** Small PNG data URL, when the platform could produce one. */
  iconDataUrl?: string;
};

/** Everything the launcher can show, in one payload. */
export type LauncherCatalog = {
  plugins: LauncherPluginEntry[];
  apps: LauncherAppEntry[];
  /**
   * True while the background application scan is still running, so the panel
   * can show "scanning" instead of an authoritative empty section.
   */
  appsScanning: boolean;
};

export type LauncherOpenAppRequest = {
  appId: string;
};

/**
 * Open a plugin panel from the launcher, optionally handing it the input that
 * triggered it. `payload` is delivered to the plugin exactly once, only to the
 * plugin the user chose (docs/spec/07-plugins/17-plugin-launcher.md §5).
 */
export type LauncherOpenPluginRequest = {
  pluginId: string;
  triggerId?: string;
  payload?: string;
};

/** The launch payload a plugin panel receives, as `pi.launcher.consume()`. */
export type PluginLauncherPayload = {
  triggerId: string;
  payload: string;
};

/** Longest payload the host forwards to a plugin; longer inputs are refused. */
export const LAUNCHER_PAYLOAD_MAX_LENGTH = 512;

/** Longest launcher input the renderer matches declared triggers against. */
export const LAUNCHER_TRIGGER_INPUT_MAX_LENGTH = 256;
