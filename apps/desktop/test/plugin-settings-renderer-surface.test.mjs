import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("scenic extensions are host-rendered, accessible, and have no iframe canvas", () => {
  const page = read("src/features/settings/SettingsPage.tsx");
  const component = read("src/components/settings/PluginScenicThemesDestination.tsx");
  const css = read("src/styles/settings.css");
  assert.match(page, /PluginScenicThemesDestination/);
  assert.doesNotMatch(page, /PluginSettingsDestination/);
  assert.match(page, /pluginViewIcon\(entry\.icon\)/);
  assert.doesNotMatch(page, /settings-nav-icon"><IconBookOpen/);
  assert.match(component, /aria-pressed/);
  assert.match(component, /type="range"/);
  assert.match(component, /"Apply"/);
  assert.doesNotMatch(component, /<iframe/);
  assert.match(css, /\.plugin-scenic-themes-destination\s*\{[\s\S]*?background:\s*transparent/s);
});

test("scenic blur persists only after the host-owned Apply action", () => {
  const ipc = read("electron/main/ipc/plugin-ui-ipc.ts");
  const protocol = read("../../packages/shared/src/protocol.ts");
  const api = read("src/lib/api.ts");
  const component = read("src/components/settings/PluginScenicThemesDestination.tsx");
  assert.match(protocol, /pluginScenicThemesSetBlur/);
  assert.match(ipc, /pluginScenicThemesSetBlur/);
  assert.match(ipc, /--nexus-backdrop-blur/);
  assert.match(api, /setPluginScenicThemeBlur/);
  assert.match(component, /setPluginScenicThemeBlur/);
  assert.match(component, /setDraftBlur/);
});

test("window controls have a compositor layer above Settings destinations", () => {
  const chrome = read("src/styles/chrome.css");
  assert.match(chrome, /\.window-controls\s*\{[\s\S]*?z-index:\s*1000/s);
  assert.match(chrome, /\.app-shell\s*>\s*\.window-controls\s*\{[\s\S]*?z-index:\s*1100/s);
  assert.match(
    chrome,
    /\.app-shell\s*>\s*\.search-overlay,\s*\n\.app-shell\s*>\s*\.toast-viewport\s*\{[\s\S]*?z-index:\s*1200/s,
  );
  assert.match(chrome, /\.app-shell\s*>\s*\.startup-splash\s*\{[\s\S]*?z-index:\s*1300/s);
});
