import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const shared = await read("../../../packages/shared/src/types.ts");
const sdk = await read("../../../packages/plugin-sdk/src/index.ts");
const runtime = await read("../electron/main/plugin-runtime.ts");
const main = await read("../electron/main/index.ts");
const protocol = await read("../../../packages/shared/src/protocol.ts");
const page = await read("../src/pages/PluginsPage.tsx");
const sheet = await read("../src/components/plugins/PluginSettingsSheet.tsx");
const app = await read("../src/App.tsx");

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

test("settings writes validate values, notify the plugin, and never use global shortcuts", () => {
  assert.match(protocol, /pluginSettingsGet/);
  assert.match(protocol, /pluginSettingsSet/);
  assert.match(main, /plugins\.getPluginSettings/);
  assert.match(main, /plugins\.setPluginSettings/);
  assert.match(runtime, /plugin:settingsChanged/);
  assert.match(runtime, /isAllowedKeybinding/);
  assert.match(app, /isActiveInProject\(plugin, projectPath\)/);
  assert.match(app, /api\.executeCommand\(pluginShortcut\.setting\.command/);
  assert.doesNotMatch(runtime, /globalShortcut/);
});
