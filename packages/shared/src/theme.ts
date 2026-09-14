import type { ThemePreference } from "./types.js";

/** The two palettes anything can resolve to. */
export type ThemeColorScheme = "light" | "dark";

/**
 * A built-in theme preference. `system` is a preference rather than a palette:
 * it has no fixed colours, and each call site resolves it against its own
 * authority — `matchMedia` in the renderer, `nativeTheme` in main.
 */
export type BuiltinThemePreference = Exclude<ThemePreference, `plugin:${string}`>;

export type BuiltinTheme = {
  id: ThemeColorScheme;
  /** Palette the theme's overrides layer on. Fixed for a built-in theme. */
  base: ThemeColorScheme;
  /**
   * Native window background on Windows/Linux, as `#rrggbb`.
   *
   * The renderer, the main process, the plugin panel host, and the panel
   * preload all read this value here. macOS keeps `vibrancy` and is never sent
   * one.
   */
  windowBackground: string;
};

/**
 * The one place a built-in palette's window background is written down.
 *
 * Before this existed the same `#ffffff` / `#181818` pair was spelled out in
 * four files, so changing the dark plate meant finding all four. A contributed
 * theme declares the same value through
 * `contributes.windowAppearance.backgroundColor` (ADR 0248).
 */
const BUILTIN_THEME_BY_ID: Record<ThemeColorScheme, BuiltinTheme> = {
  light: { id: "light", base: "light", windowBackground: "#ffffff" },
  dark: { id: "dark", base: "dark", windowBackground: "#181818" },
};

/** Picker order for the built-in section, ahead of any contributed theme. */
export const BUILTIN_THEME_PREFERENCES: readonly BuiltinThemePreference[] = [
  "system",
  BUILTIN_THEME_BY_ID.light.id,
  BUILTIN_THEME_BY_ID.dark.id,
];

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  BUILTIN_THEME_BY_ID.light,
  BUILTIN_THEME_BY_ID.dark,
];

/** True when a stored preference names a palette instead of `system`/`plugin:`. */
export function isThemeColorScheme(value: unknown): value is ThemeColorScheme {
  return value === "light" || value === "dark";
}

/** True when a stored preference is one of the built-in options. */
export function isBuiltinThemePreference(value: unknown): value is BuiltinThemePreference {
  return value === "system" || isThemeColorScheme(value);
}

/** Native window background for a resolved built-in palette. */
export function builtinWindowBackground(scheme: ThemeColorScheme): string {
  return BUILTIN_THEME_BY_ID[scheme].windowBackground;
}
