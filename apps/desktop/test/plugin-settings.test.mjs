import { readAppSource, readPluginsSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readSharedTypesSource } from "./helpers/source-contracts.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const shared = await readSharedTypesSource();
const sdk = await read("../../../packages/plugin-sdk/src/index.ts");
const runtime = await read("../electron/main/plugin-runtime.ts");
const main = await readMainSource();
const protocol = await read("../../../packages/shared/src/protocol.ts");
const page = await readPluginsSource();
const sheet = await read("../src/components/plugins/PluginSettingsSheet.tsx");
const app = await readAppSource();

test("plugin settings expose generated fields and plugin-local shortcut metadata", () => {
  assert.match(shared, /PluginSettingType[\s\S]*"shortcut"/);
  assert.match(shared, /settings\?: PluginSettingDefinition\[\]/);
  assert.match(sdk, /command\?: string/);
  assert.match(sdk, /scope\?: "plugin"/);
  assert.match(sdk, /shortcut setting.*requires a command/);
  assert.match(page, /<PluginSettingsSheet/);
  assert.match(sheet, /type === "json"/);
  assert.match(sheet, /keybindingFromEvent/);
  assert.match(sheet, /api\.setPluginSettings/);
});

test("generated plugin settings stay author-language; plugins localize from the host locale", () => {
  assert.match(sdk, /export type PluginSettingContrib = \{[\s\S]*?title: string;/);
  assert.doesNotMatch(
    sdk,
    /export type PluginSettingContrib = \{[\s\S]*?title: string \| PluginLocalizedString/,
  );
  assert.doesNotMatch(runtime, /resolvePluginLocalizedString\(setting\.title/);
  assert.match(main, /plugins\.broadcastEvent\("appearance:changed"/);
  assert.match(sdk, /getLocale: \(\) => Promise<string>/);
});

test("settings writes validate values, notify the plugin, and never use global shortcuts", () => {
  assert.match(protocol, /pluginSettingsGet/);
  assert.match(protocol, /pluginSettingsSet/);
  assert.match(main, /plugins\.getPluginSettings/);
  assert.match(main, /plugins\.setPluginSettings/);
  assert.match(runtime, /plugin:settingsChanged/);
  assert.match(runtime, /isAllowedKeybinding/);
  assert.match(app, /isActiveInProject\(plugin, projectPath\)/);
  assert.match(app, /api\.executeCommand\(pluginShortcut\.setting\.command/);
  // The runtime routes plugin accelerators into the host-owned registry; it
  // must never call Electron's API itself, and a plugin's window-scoped
  // shortcut setting still must not become a system-wide binding.
  assert.doesNotMatch(runtime, /globalShortcut\.(?:register|unregister)\(/);
  assert.match(runtime, /assertPermission\(loaded, "keyboard\.globalShortcut"\)/);
});
