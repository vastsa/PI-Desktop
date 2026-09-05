import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const mainSrc = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");
const appSrc = readFileSync(join(desktopRoot, "src/App.tsx"), "utf8");
const settingsSrc = readFileSync(join(desktopRoot, "src/pages/SettingsPage.tsx"), "utf8");
const themeRowSrc = readFileSync(join(desktopRoot, "src/components/settings/ThemeRow.tsx"), "utf8");
const storeSrc = readFileSync(join(desktopRoot, "src/stores/app-store.ts"), "utf8");
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");

test("contributed css is sanitized in the main process, not the renderer", () => {
  const register = runtimeSrc.slice(runtimeSrc.indexOf("private registerThemes"));
  assert.match(register, /sanitizeThemeCss\(raw\)/);
  assert.match(register, /resolveInsidePlugin/);
  assert.match(register, /INVALID_CSS/);
  assert.match(runtimeSrc, /MAX_THEMES_PER_PLUGIN = 8/);
  // The renderer injects the stored text verbatim, so it must not re-filter.
  assert.doesNotMatch(appSrc, /sanitizeThemeCss/);
});

test("themes only load with ui.theme and are withdrawn on unload", () => {
  const register = runtimeSrc.slice(runtimeSrc.indexOf("private registerThemes"));
  assert.match(register, /permissions\.has\("ui\.theme"\)/);
  assert.match(register, /plugin\.themes\.skipped/);
  const clear = runtimeSrc.slice(
    runtimeSrc.indexOf("private clearContributions"),
    runtimeSrc.indexOf("private registerSkills"),
  );
  assert.match(clear, /this\.themes/);
});

test("the theme list has its own channel and is refreshed on plugin changes", () => {
  assert.match(protocolSrc, /pluginThemes: "pi-desktop\/plugin\/themes"/);
  assert.match(mainSrc, /handle\(IPC\.invoke\.pluginThemes, async \(\) => plugins\.getThemes\(\)\)/);
  // Enable/disable/uninstall change which themes exist.
  for (const reason of ["enable", "disable", "uninstall"]) {
    assert.match(mainSrc, new RegExp(`reason: "${reason}"`));
  }
  assert.match(storeSrc, /refreshPluginThemes/);
  assert.match(appSrc, /api\.onPluginChanged\(\(\) => void refreshPluginThemes\(\)\)/);
});

test("an unavailable plugin theme falls back to the system palette", () => {
  const effect = appSrc.slice(appSrc.indexOf("const preference = settings?.theme"));
  assert.match(effect, /preference\.startsWith\("plugin:"\)/);
  // No matching theme in the catalog => base resolves to "system".
  assert.match(effect, /pluginTheme\s*\n?\s*\?\s*pluginTheme\.base/);
  assert.match(effect, /: "system"/);
  assert.match(effect, /style\?\.remove\(\)/);
  assert.match(effect, /PLUGIN_THEME_STYLE_ID/);
  // The style element is appended last so plugin overrides win.
  assert.match(effect, /document\.head\.append\(style\)/);
});

test("settings offers plugin themes in the searchable picker", () => {
  assert.match(settingsSrc, /<ThemeRow /);
  assert.match(themeRowSrc, /pluginThemes\.map/);
  assert.match(themeRowSrc, /saveSettings\(\{ theme: id \}\)/);
  assert.match(themeRowSrc, /settings\.themeFromPlugin/);
  assert.match(themeRowSrc, /kind: "plugin"/);
  assert.doesNotMatch(settingsSrc, /settings-theme-grid/);
  assert.doesNotMatch(settingsSrc, /settings-theme-card/);
});
