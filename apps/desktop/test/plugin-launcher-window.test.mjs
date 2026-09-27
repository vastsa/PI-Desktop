import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [main, renderer, launcher, styles] = await Promise.all([
  readFile(new URL("../electron/main/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/PluginLauncher.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/plugin-launcher.css", import.meta.url), "utf8"),
]);

test("global plugin launcher is a centered frameless cross-platform utility window", () => {
  assert.match(main, /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/);
  assert.match(main, /frame: false/);
  assert.match(main, /minimizable: false/);
  assert.match(main, /maximizable: false/);
  assert.match(main, /fullscreenable: false/);
  assert.match(main, /process\.platform === "darwin" \? \{ type: "panel" as const \}/);
  assert.match(main, /input\.code === "Space"[\s\S]*input\.alt/);
  assert.match(main, /globalShortcut\.register\(accelerator/);
  assert.match(main, /keyboard\.setGlobalShortcut/);
  assert.match(main, /pluginLauncherBinding === "Alt\+Space"/);
  assert.match(main, /let pluginLauncherCreationPromise: Promise<BrowserWindow>/);
  assert.match(
    main,
    /if \(pluginLauncherCreationPromise\) return pluginLauncherCreationPromise/,
  );
  assert.match(main, /function prewarmPluginLauncher\(\): void/);
  assert.ok(
    main.indexOf("prewarmPluginLauncher();") < main.indexOf("await bootBackends();"),
    "launcher warm-up should start before backend boot",
  );
  assert.doesNotMatch(main, /await ensureWindow\(\);\s+prewarmPluginLauncher\(\)/);
  assert.match(main, /window\.show\(\);\s+\/\/ `show\(\)` already activates and focuses a macOS panel\./);
  assert.match(main, /process\.platform !== "darwin"\) \{[\s\S]*window\.focus\(\);[\s\S]*window\.moveTop\(\);/);
  assert.doesNotMatch(main, /process\.platform === "darwin"\) app\.focus\(\{ steal: true \}\)/);
  assert.match(main, /window\.on\("blur"[\s\S]*window\.hide\(\)/);
});

test("launcher never turns the app into a macOS accessory process", () => {
  assert.match(
    main,
    /setVisibleOnAllWorkspaces\(true, \{\s*visibleOnFullScreen: true,\s*skipTransformProcessType: true,\s*\}\)/,
  );
  assert.doesNotMatch(main, /app\.dock\.hide\(\)/);
  assert.doesNotMatch(main, /setActivationPolicy/);
});

test("launcher renderer supports keyboard selection and has no window controls", () => {
  assert.match(renderer, /rendererSurface === "plugin-launcher" \? <PluginLauncher \/>/);
  assert.match(launcher, /event\.nativeEvent\.isComposing/);
  assert.match(launcher, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(launcher, /event\.key === "Enter"/);
  assert.match(launcher, /event\.key === "Escape"/);
  assert.match(launcher, /api\.openPluginPanel\(plugin\.id\)/);
  assert.match(launcher, /loadPromiseRef/);
  assert.match(launcher, /inputRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(launcher, /requestAnimationFrame\(\(\) => inputRef/);
  assert.doesNotMatch(launcher, /WindowControls|window-controls/);
  assert.match(styles, /html\[data-surface="plugin-launcher"\][\s\S]*background: transparent/);
});
