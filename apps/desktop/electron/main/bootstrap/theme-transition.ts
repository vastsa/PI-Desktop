/**
 * Palette bookkeeping for native theme transitions (#2215).
 *
 * `applyAppThemePreference` snapshots `nativeTheme.shouldUseDarkColors` once
 * per settings write; this module carries the decision of whether a later OS
 * appearance flip may move that snapshot. An explicit light/dark scheme pins
 * the palette, a contributed plugin theme with a base is fixed by its author,
 * and only `system` — or a `plugin:` theme whose registry entry is gone or
 * baseless, which falls back to the OS — follows the appearance. Dependency
 * free so tests can drive transitions without Electron.
 */

export type PluginPanelTheme = "light" | "dark";

export type ThemeBaseSource = { base?: "light" | "dark" } | undefined;

export function pluginPanelThemeFollowsSystem(
  preference: unknown,
  findTheme: (id: string) => ThemeBaseSource,
): boolean {
  if (preference === "light" || preference === "dark") return false;
  if (typeof preference === "string" && preference.startsWith("plugin:")) {
    const theme = findTheme(preference.slice("plugin:".length));
    return theme?.base !== "light" && theme?.base !== "dark";
  }
  return true;
}

export function resolvedPluginPanelTheme(shouldUseDarkColors: boolean): PluginPanelTheme {
  return shouldUseDarkColors ? "dark" : "light";
}
