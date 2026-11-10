import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  pluginPanelThemeFollowsSystem,
  resolvedPluginPanelTheme,
} from "../electron/main/bootstrap/theme-transition.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const lifecycleSrc = await read("../electron/main/bootstrap/app-lifecycle.ts");
const shutdownSrc = await read("../electron/main/bootstrap/shutdown.ts");
const indexSrc = await read("../electron/main/index.ts");

test("only system-following preferences react to a native theme transition", () => {
  const noThemes = () => undefined;
  // `system` tracks the OS.
  assert.equal(pluginPanelThemeFollowsSystem("system", noThemes), true);
  assert.equal(pluginPanelThemeFollowsSystem(undefined, noThemes), true);
  // An explicit scheme pins the palette against OS flips.
  assert.equal(pluginPanelThemeFollowsSystem("light", noThemes), false);
  assert.equal(pluginPanelThemeFollowsSystem("dark", noThemes), false);
  // The lookup mimics the real registry: plugins.getThemes() keys entries by
  // the full `plugin:`-prefixed id, so the helper must match the preference
  // verbatim — a prefix-stripped lookup misses every entry.
  const registry = [
    { id: "plugin:midnight", base: "dark" },
    { id: "plugin:unstyled", base: undefined },
  ];
  const findInRegistry = (id) => registry.find((theme) => theme.id === id);
  // A contributed theme with a base is fixed by its author.
  assert.equal(
    pluginPanelThemeFollowsSystem("plugin:midnight", findInRegistry),
    false,
  );
  // A plugin theme without a base falls back to the OS, so it follows.
  assert.equal(
    pluginPanelThemeFollowsSystem("plugin:unstyled", findInRegistry),
    true,
  );
  // A plugin whose theme is gone falls back to the OS, so it follows too.
  assert.equal(pluginPanelThemeFollowsSystem("plugin:gone", findInRegistry), true);
});

test("the resolved palette follows the OS dark flag", () => {
  assert.equal(resolvedPluginPanelTheme(true), "dark");
  assert.equal(resolvedPluginPanelTheme(false), "light");
});

test("the lifecycle refreshes the palette on native theme updates and detaches at quit", () => {
  // #2215: applyAppThemePreference snapshots shouldUseDarkColors once; the
  // lifecycle must subscribe to `updated`, re-resolve only system-following
  // palettes, broadcast, and remove the listener at shutdown.
  assert.match(lifecycleSrc, /nativeTheme\.on\("updated", onNativeThemeUpdated\)/);
  assert.match(lifecycleSrc, /nativeTheme\.off\("updated", onNativeThemeUpdated\)/);
  assert.match(lifecycleSrc, /pluginPanelThemeFollowsSystem\(appearanceState\.appThemePreference/);
  assert.match(lifecycleSrc, /resolvedPluginPanelTheme\(nativeTheme\.shouldUseDarkColors\)/);
  assert.match(lifecycleSrc, /broadcastAppearance\(\)/);
  // The dispose travels the same wiring the power-save blockers use.
  assert.match(lifecycleSrc, /disposeNativeThemeListener/);
  assert.match(indexSrc, /disposeNativeThemeListener/);
  assert.match(shutdownSrc, /disposeNativeThemeListener\?\.\(\)/);
});
