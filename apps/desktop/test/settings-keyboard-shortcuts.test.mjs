import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const shortcutSource = await readFile(
  new URL("../../../packages/shared/src/keyboard-shortcuts.ts", import.meta.url),
  "utf8",
);
const sharedTypesSource = await readFile(
  new URL("../../../packages/shared/src/types.ts", import.meta.url),
  "utf8",
);
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../electron/main/application-menu.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const settingsSource = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const sectionSource = await readFile(
  new URL("../src/components/settings/KeyboardShortcutsSection.tsx", import.meta.url),
  "utf8",
);
const searchSource = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const stylesSource = await loadStyles();

test("shared shortcut map drives renderer dispatch and native menu accelerators", () => {
  for (const id of [
    "navigateBack",
    "navigateForward",
    "newTask",
    "openProject",
    "openSettings",
    "openSearch",
    "openCommandPalette",
    "toggleSidebar",
    "openWorkPanel",
    "openPluginLauncher",
    "abort",
    "closeWindow",
    "resetZoom",
    "zoomIn",
    "zoomOut",
    "toggleFullScreen",
  ]) {
    assert.match(shortcutSource, new RegExp(`"${id}"`));
  }
  assert.match(appSource, /KEYBOARD_SHORTCUTS\.find/);
  assert.match(appSource, /settings\?\.keybindings/);
  assert.match(appSource, /keybindingMatchesEvent/);
  assert.match(appSource, /keybindingDisplayParts/);
  assert.match(appSource, /case "openWorkPanel"/);
  assert.match(appSource, /useAppStore\.getState\(\)\.toggleWorkPanel\(\)/);
  assert.match(menuSource, /resolveKeybinding\(shortcut, keybindings/);
  assert.match(menuSource, /keybindingToElectronAccelerator/);
  assert.match(mainSource, /applyApplicationMenuSettings/);
  assert.match(mainSource, /keybindings\?:\s*unknown/);
  assert.match(mainSource, /applyPluginLauncherShortcut/);
  assert.match(mainSource, /globalShortcut\.register/);
  assert.match(mainSource, /keyboard\.setGlobalShortcut/);
  assert.match(mainSource, /pluginLauncherBinding: string \| null/);
  assert.match(mainSource, /pluginLauncherAccelerator && pluginLauncherAccelerator !== accelerator/);
  assert.match(mainSource, /method === "keyboard\.shortcut"/);
});

test("global shortcut dispatch ignores incomplete keyboard events", () => {
  assert.match(appSource, /modifierOnly/);
  assert.match(appSource, /e\.isComposing/);
  assert.match(appSource, /e\.keyCode === 229/);
  assert.match(
    appSource,
    /e\.repeat[\s\S]*shortcut\.id === "navigateBack"[\s\S]*shortcut\.id === "navigateForward"/,
  );
});

test("Basics exposes editable, conflict-safe, resettable shortcut mappings", () => {
  assert.match(sharedTypesSource, /keybindings\?: KeybindingOverrides/);
  assert.match(
    shortcutSource,
    /export type KeybindingOverrides = Partial<Record<KeyboardShortcutId, string \| null>>/,
  );
  assert.match(settingsSource, /<KeyboardShortcutsSection/);
  assert.match(sectionSource, /keybindingFromEvent/);
  assert.match(sectionSource, /isAllowedKeybinding/);
  assert.match(sectionSource, /isReservedKeybinding/);
  assert.match(sectionSource, /keybindingsConflict/);
  assert.match(sectionSource, /settings\.shortcutConflict/);
  assert.match(sectionSource, /settings\.shortcutUnbound/);
  assert.match(sectionSource, /settings\.shortcutDisable/);
  assert.match(sectionSource, /hasOwnProperty\.call/);
  assert.match(sectionSource, /mode === "disabled"/);
  assert.match(sectionSource, /onKeyDown=\{\s*recording/);
  assert.match(sectionSource, /delete next\[shortcut\.id\]/);
  assert.match(sectionSource, /saveSettings\(\{ keybindings: \{\} \}\)/);
  assert.match(searchSource, /settings\.keyboard/);
  assert.match(stylesSource, /\.shortcut-recorder\.recording\s*\{/);
  assert.match(stylesSource, /\.shortcut-keybinding kbd\s*\{/);
});
