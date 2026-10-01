import { readAppSourceSync, readSettingsSourceSync, readStoreSourceSync, readMainSourceSync } from "./helpers/source-contracts.mjs";
import { sanitizeThemeCss } from "@pi-desktop/plugin-sdk";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  readThemeAssetBytes,
  resolvePackageThemeAssetPath,
  themeAssetGroupWithinBudget,
} from "../electron/main/plugin-theme-assets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const mainSrc = readMainSourceSync();
const appSrc = readAppSourceSync();
const settingsSrc = readSettingsSourceSync();
const themeRowSrc = readFileSync(join(desktopRoot, "src/components/settings/ThemeRow.tsx"), "utf8");
const storeSrc = readStoreSourceSync();
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");

test("contributed css is sanitized in the main process, not the renderer", () => {
  const register = runtimeSrc.slice(runtimeSrc.indexOf("private registerThemes"));
  assert.match(register, /sanitizeThemeCss\(raw,\s*THEME_CSS_MAX_BYTES,/);
  assert.match(register, /resolveInsidePlugin/);
  assert.match(register, /INVALID_CSS/);
  // The hard per-plugin theme cap was removed (ADR 0260 / issue #352).
  assert.doesNotMatch(runtimeSrc, /MAX_THEMES_PER_PLUGIN/);
  // The renderer injects the stored text verbatim, so it must not re-filter.
  assert.doesNotMatch(appSrc, /sanitizeThemeCss/);
});

test("runtime theme APIs and setTheme are allowlisted and wired", () => {
  assert.match(runtimeSrc, /"app\.setTheme"/);
  assert.match(runtimeSrc, /"themes\.upsert"/);
  assert.match(runtimeSrc, /"themes\.remove"/);
  assert.match(runtimeSrc, /"themes\.list"/);
  assert.match(runtimeSrc, /setThemePreference/);
  assert.match(runtimeSrc, /onPluginThemesChanged/);
  assert.match(mainSrc, /wirePluginThemeRuntimeServices/);
  const themeServicesSrc = readFileSync(
    join(desktopRoot, "electron/main/plugin-theme-services.ts"),
    "utf8",
  );
  assert.match(themeServicesSrc, /setThemePreference/);
  assert.match(themeServicesSrc, /IPC\.event\.settingsChanged/);
  assert.match(themeServicesSrc, /reason: "themes"/);
  // Child host process must expose the same surface.
  const childSrc = readFileSync(
    join(desktopRoot, "electron/main/plugin-host-process.mjs"),
    "utf8",
  );
  assert.match(childSrc, /setTheme:\s*\(themeId\)/);
  assert.match(childSrc, /themes:\s*\{/);
  // Panel bridge channels.
  assert.match(runtimeSrc, /case "app\.setTheme"/);
  assert.match(runtimeSrc, /case "themes\.upsert"/);
  assert.match(runtimeSrc, /case "themes\.list"/);
  // Renderer applies host-originated theme writes.
  assert.match(appSrc, /api\.onSettingsChanged/);
});

test("app.setTheme applies the theme alone, never other settings", () => {
  const themeServicesSrc = readFileSync(
    join(desktopRoot, "electron/main/plugin-theme-services.ts"),
    "utf8",
  );
  const lifecycleSrc = readFileSync(
    join(desktopRoot, "electron/main/bootstrap/app-lifecycle.ts"),
    "utf8",
  );
  // `applyApplicationMenuSettings` treats absent fields as unset, so calling it
  // with `{ theme }` would also reset the locale, keybindings, and dev-mode
  // menu state. The plugin path must use the theme-only entry point instead.
  assert.match(themeServicesSrc, /applyAppThemePreference/);
  assert.doesNotMatch(themeServicesSrc, /applyApplicationMenuSettings/);
  assert.match(lifecycleSrc, /function applyAppThemePreference\(preference: unknown\)/);
  // The full-settings path reuses the same theme mapping.
  assert.match(lifecycleSrc, /applyAppThemePreference\(settings\?\.theme\)/);
});

test("sidebar paints color and optional image layers separately", () => {
  const tokensSrc = readFileSync(join(desktopRoot, "src/styles/tokens.css"), "utf8");
  const chromeSrc = readFileSync(join(desktopRoot, "src/styles/chrome.css"), "utf8");
  assert.match(tokensSrc, /--ds-bg-sidebar-image:\s*none/);
  assert.match(chromeSrc, /background-color:\s*var\(--ds-bg-sidebar/);
  assert.match(chromeSrc, /background-image:\s*var\(--ds-bg-sidebar-image/);
  // macOS stacks the optional image under the glass sheen.
  const darwin = chromeSrc.slice(chromeSrc.indexOf('data-platform="darwin"'));
  assert.match(darwin, /--ds-bg-sidebar-image/);
});

test("scenic plugins use the normal full-window shell for compositing", () => {
  const baseSrc = readFileSync(join(desktopRoot, "src/styles/base.css"), "utf8");
  const settingsSrc = readFileSync(join(desktopRoot, "src/styles/settings.css"), "utf8");
  assert.match(baseSrc, /\.app-shell\s*\{[^}]*position:\s*relative;[^}]*isolation:\s*isolate/s);
  assert.match(baseSrc, /\.app-scenic-backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/s);
  // The backdrop is the shell's first child with `position: fixed`, so it needs
  // no z-index sibling rule; such a rule would turn `.main-pane` into a stacking
  // context and pin route overlays underneath the window chrome.
  assert.doesNotMatch(baseSrc, /\.app-shell\s*>\s*:not\(\.app-scenic-backdrop\)/);
  assert.match(settingsSrc, /data-plugin-theme\^="plugin:io\.github\.akshayxkill\.nexus-scenic-themes:/);
  assert.match(settingsSrc, /\.app-shell\.settings-mode[^}]*background:\s*transparent\s*!important/s);
  assert.match(settingsSrc, /\.settings-content[^}]*background:\s*transparent\s*!important/s);
});

test("scenic plugin themes expose a full-window settings compositing hook", () => {
  const settingsCss = readFileSync(join(desktopRoot, "src/styles/settings.css"), "utf8");
  assert.match(settingsCss, /data-plugin-theme\^="plugin:io\.github\.akshayxkill\.nexus-scenic-themes:/);
  assert.match(settingsCss, /\.app-shell\.settings-mode[^}]*background:\s*transparent\s*!important/s);
  assert.match(settingsCss, /\.settings-content[^}]*background:\s*transparent\s*!important/s);
  assert.match(settingsCss, /\.settings-shell-full\s+\.settings-nav\.sidebar-surface[^}]*background:\s*color-mix/s);
  assert.match(settingsCss, /\.settings-panel[^}]*background:\s*color-mix/s);
});

test("scenic background is a host root layer, not an app-shell pseudo-element", () => {
  assert.match(appSrc, /className=\"app-scenic-backdrop\"/);
  assert.match(readFileSync(join(desktopRoot, "src/styles/base.css"), "utf8"), /\.app-scenic-backdrop\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(
    readFileSync(join(desktopRoot, "src/styles/base.css"), "utf8"),
    /\.app-shell\s*>\s*:\s*not\(/,
  );
});

test("core Settings navigation dismisses an active plugin destination", () => {
  const source = readFileSync(join(desktopRoot, "src/features/settings/SettingsPage.tsx"), "utf8");
  assert.match(source, /setActiveExtension\(null\);\s*setSettingsTab\(item\.id\);/s);
});

test("host window-control band inherits the active theme palette without plugin geometry", () => {
  const chromeCss = readFileSync(join(desktopRoot, "src/styles/chrome.css"), "utf8");
  const scenicSettingsCss = readFileSync(join(desktopRoot, "src/styles/settings.css"), "utf8");
  assert.match(chromeCss, /\.window-controls\s*\{[^}]*position:\s*fixed;[^}]*background:\s*var\(--ds-bg-primary\)/s);
  assert.match(chromeCss, /\.app-shell\s*>\s*\.window-controls\s*\{[^}]*z-index:\s*1100/s);
  assert.doesNotMatch(scenicSettingsCss, /\.window-controls\s*\{/);
});

test("host-rendered scenic Settings destinations leave native controls outside extension content", () => {
  const component = readFileSync(join(repoRoot, "apps/desktop/src/components/settings/PluginScenicThemesDestination.tsx"), "utf8");
  const css = readFileSync(join(repoRoot, "apps/desktop/src/styles/settings.css"), "utf8");
  assert.doesNotMatch(component, /<iframe/);
  assert.match(css, /\.plugin-scenic-themes-destination\s*\{[\s\S]*?background:\s*transparent/s);
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

test("declared theme assets are served over a host-owned scheme", () => {
  const protocolSrc = readFileSync(
    join(desktopRoot, "electron/main/plugin-asset-protocol.ts"),
    "utf8",
  );
  const startupSrc = readFileSync(
    join(desktopRoot, "electron/main/bootstrap/startup.ts"),
    "utf8",
  );
  const schemesSrc = readFileSync(
    join(desktopRoot, "electron/main/plugin-schemes.ts"),
    "utf8",
  );
  const htmlSrc = readFileSync(join(desktopRoot, "index.html"), "utf8");

  // The scheme is reserved before the app is ready, then handled by a resolver
  // that only answers for paths the loaded plugin actually declared.
  assert.match(startupSrc, /registerPluginSchemes\(\);/);
  assert.match(startupSrc, /installPluginAssetProtocol\(/);
  assert.match(protocolSrc, /scheme: THEME_ASSET_SCHEME/);
  assert.match(schemesSrc, /registerSchemesAsPrivileged\(\[[^\]]*PLUGIN_ASSET_SCHEME_PRIVILEGES/);
  assert.match(protocolSrc, /protocol\.handle\(THEME_ASSET_SCHEME/);
  assert.match(protocolSrc, /resolve\(pluginId, assetPath\)/);
  assert.match(protocolSrc, /x-content-type-options/);
  // The renderer must be allowed to load the scheme it is handed.
  assert.match(htmlSrc, /img-src[^;]*plugin-asset:/);
  assert.match(htmlSrc, /font-src[^;]*plugin-asset:/);
});

test("theme css only reaches package bytes through the declared list", () => {
  const register = runtimeSrc.slice(runtimeSrc.indexOf("private registerThemes"));
  assert.match(register, /resolveThemeAssets\(/);
  assert.match(register, /themeAssetUrl\(pluginId, normalized\)/);
  assert.match(register, /assets\.files\.has\(normalized\)/);
  assert.match(runtimeSrc, /sanitizeThemeCss\(raw, THEME_CSS_MAX_BYTES/);
  // A disabled plugin stops serving its assets.
  const clear = runtimeSrc.slice(
    runtimeSrc.indexOf("private clearContributions"),
    runtimeSrc.indexOf("private registerSkills"),
  );
  assert.match(clear, /this\.themeAssets\.delete\(pluginId\)/);
});

test("a contributed window background needs its own grant", () => {
  const register = runtimeSrc.slice(runtimeSrc.indexOf("private registerThemes"));
  assert.match(register, /permissions\.has\("ui\.window\.appearance"\)/);
  assert.match(register, /resolveWindowBackground\(/);
  assert.match(runtimeSrc, /windowBackground\?: \{ light\?: string; dark\?: string \}/);
});

test("the shipped example theme survives sanitation", () => {
  const css = readFileSync(
    join(repoRoot, "examples/plugins/hello/themes/midnight.css"),
    "utf8",
  );
  // The file only *names* the banned token, inside its header comment.
  assert.match(css, /@import/);
  assert.equal(sanitizeThemeCss(css).ok, true);
});

test("package-relative theme assets stay canonicalized inside their plugin", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-plugin-theme-assets-"));
  const plugin = join(parent, "plugin");
  const asset = join(plugin, "art/bg.png");
  const secondAsset = join(plugin, "art/second.png");
  try {
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(asset, "image");
    await writeFile(secondAsset, "image");
    const registered = resolvePackageThemeAssetPath(plugin, "art/bg.png");
    const secondRegistered = resolvePackageThemeAssetPath(plugin, "art/second.png");
    assert.ok(registered);
    assert.ok(secondRegistered);
    assert.equal(registered, realpathSync(asset));
    const initialBytes = readThemeAssetBytes(registered);
    assert.equal(Buffer.from(initialBytes ?? []).toString("utf8"), "image");
    assert.equal(
      resolvePackageThemeAssetPath(plugin, "../outside.png"),
      null,
    );

    const group = new Map([
      ["art/bg.png", registered],
      ["art/second.png", secondRegistered],
    ]);
    assert.equal(themeAssetGroupWithinBudget(plugin, group), true);
    const twoMiBPlusOne = Buffer.alloc(2 * 1024 * 1024 + 1);
    await writeFile(asset, twoMiBPlusOne);
    await writeFile(secondAsset, twoMiBPlusOne);
    assert.equal(themeAssetGroupWithinBudget(plugin, group), false);

    await writeFile(asset, Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.equal(readThemeAssetBytes(registered), null);
    await writeFile(asset, "image");

    if (process.platform !== "win32") {
      const outside = join(parent, "outside.png");
      await writeFile(outside, "outside");
      await rm(asset);
      await symlink(outside, asset);
      assert.equal(resolvePackageThemeAssetPath(plugin, "art/bg.png"), null);
      assert.equal(readThemeAssetBytes(registered), null);
    }

    assert.match(runtimeSrc, /resolvePackageThemeAssetPath\(pluginPath,\s*normalized\)/);
    assert.match(runtimeSrc, /resolvePackageThemeAssetPath\(loaded\.path,\s*normalized\)/);
    assert.match(runtimeSrc, /themeAssetGroupWithinBudget\(loaded\.path, group\)/);
    const assetProtocolSrc = readFileSync(join(desktopRoot, "electron/main/plugin-asset-protocol.ts"), "utf8");
    assert.match(assetProtocolSrc, /PluginAssetResolver = .*Uint8Array \| null/);
    assert.doesNotMatch(assetProtocolSrc, /readFileSync/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
