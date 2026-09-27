export const PLUGIN_PANEL_TITLEBAR_HEIGHT = 46;

/**
 * Opt-in marker for plugin pages that use the host-published titlebar CSS
 * variable. Pages with this marker own their normal-flow top spacing; legacy
 * pages keep the host's additive padding fallback.
 */
export const PLUGIN_PANEL_CHROME_META_NAME = "pi-plugin-chrome";
export const PLUGIN_PANEL_CHROME_VERSION = "v2";
/**
 * Opt-in mode for pages that draw through the transparent host drag band.
 * The host keeps the capsule above the page, while the page owns hit testing
 * and supplies its own drag/no-drag regions.
 */
export const PLUGIN_PANEL_CHROME_PAINT_THROUGH_VERSION = "v3";

export type PluginPanelTheme = "light" | "dark";

/**
 * The appearance the host is currently showing, handed to plugin panels.
 *
 * `theme` is the user's raw preference (`light` | `dark` | `system`, or
 * `plugin:<pluginId>:<themeId>` when a plugin theme is active). `base` is the
 * palette that preference resolves to — `"system"` only when the host could
 * not resolve it, which the panel renderer treats as "follow the OS".
 * `pluginTheme` carries the active contributed theme's sanitized CSS so a
 * panel can mirror the app's custom palette exactly.
 */
export type PluginAppearance = {
  /** Raw preference stored in AppSettings.theme. */
  theme: string;
  /** Resolved palette: "light" | "dark", or "system" when unresolved. */
  base: "light" | "dark" | "system";
  /** Active app language tag (e.g. "en", "zh-CN"). */
  locale: string;
  /** The active contributed theme, when the preference selects one. */
  pluginTheme: { id: string; base: "light" | "dark"; css: string } | null;
};

export const PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX = "--pi-plugin-panel-locale=";

/**
 * Marks a plugin surface as docked inside the host work panel rather than
 * living in its own window.
 *
 * An embedded view has no window to minimize, maximize, or drag, so the preload
 * skips the control capsule and the 46px safe area entirely and reports a
 * titlebar height of 0. `window.pluginBridge` is identical either way, so the
 * same HTML entry works in both placements (ADR 0092 §2 addendum).
 */
export const PLUGIN_PANEL_EMBEDDED_ARGUMENT = "--pi-plugin-panel-embedded=1";

export const PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL =
  "pi-plugin-panel-window-control";
export const PLUGIN_PANEL_WINDOW_STATE_CHANNEL =
  "pi-plugin-panel-window-state";

export const PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS = [
  "getState",
  "minimize",
  "toggleMaximize",
  "close",
] as const;

export type PluginPanelWindowControlAction =
  (typeof PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS)[number];

export function isPluginPanelWindowControlAction(
  value: unknown,
): value is PluginPanelWindowControlAction {
  return (
    typeof value === "string" &&
    PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS.includes(
      value as PluginPanelWindowControlAction,
    )
  );
}
