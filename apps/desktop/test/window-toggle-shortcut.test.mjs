/**
 * The merged window toggle (D438).
 *
 * Behavioral: `windowToggleAction` turns the live window flags into the one
 * decision a press makes, so "visible and focused hides, anything else comes
 * back" is asserted without Electron.
 *
 * Contract: the catalog ships exactly one window-visibility key, the launcher
 * registers it and nothing else, the toggle path hides instead of closing, both
 * processes fold stored legacy overrides, and every locale and the settings map
 * show the merged row.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readAppSource,
  readMainModule,
  readMainSource,
  readSettingsSource,
  readStoreSource,
} from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { windowToggleAction } = await import(
  "../electron/main/bootstrap/window-visibility.ts"
);
const {
  KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_IDS,
  isReservedKeybinding,
  migrateKeybindingOverrides,
} = await import("../../../packages/shared/src/keyboard-shortcuts.ts");
const { catalogs, flattenCatalog } = await import(
  "../../../packages/i18n/src/index.ts"
);

const mainSource = await readMainSource();
const launcherSource = await readMainModule("bootstrap/launcher.ts");
const lifecycleSource = await readMainModule("bootstrap/app-lifecycle.ts");
const shutdownSource = await readMainModule("bootstrap/shutdown.ts");
const registrySource = await readMainModule("plugin-shortcut-registry.ts");
const menuSource = await readMainModule("application-menu.ts");
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const windowControlsSource = await readFile(
  new URL("../src/components/WindowControls.tsx", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const storeSource = await readStoreSource();
const settingsSource = await readSettingsSource();
const sectionSource = await readFile(
  new URL("../src/components/settings/KeyboardShortcutsSection.tsx", import.meta.url),
  "utf8",
);

function toggleActionFor({ visible, minimized, focused }) {
  return windowToggleAction({
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
  });
}

test("the catalog ships one window toggle on Alt+Shift+W, with no summon chord", () => {
  assert.ok(KEYBOARD_SHORTCUT_IDS.includes("toggleWindow"));
  assert.equal(KEYBOARD_SHORTCUT_IDS.includes("summonWindow"), false);
  assert.equal(KEYBOARD_SHORTCUT_IDS.includes("closeWindow"), false);

  const toggle = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "toggleWindow");
  assert.equal(toggle.defaultBinding, "Alt+Shift+W");
  assert.equal(toggle.macDefaultBinding, undefined);
  const windowGroup = KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.group === "window");
  // D439: the toggle is registered process-wide, so it must avoid the chords
  // the platform owns: `Mod+W` closes a window on macOS and `Mod+Shift+W` is the
  // retired summon key. Neither is a shipped default any more.
  assert.equal(
    KEYBOARD_SHORTCUTS.some((shortcut) => shortcut.defaultBinding === "Mod+W"),
    false,
  );
  assert.equal(
    KEYBOARD_SHORTCUTS.some((shortcut) => shortcut.defaultBinding === "Mod+Shift+W"),
    false,
  );
  assert.equal(isReservedKeybinding("Mod+W", "darwin"), true);
  assert.deepEqual(
    windowGroup.map((shortcut) => shortcut.id),
    ["toggleWindow", "resetZoom", "zoomIn", "zoomOut", "toggleFullScreen"],
  );
});

test("a visible, focused window hides; anything else comes back", () => {
  assert.equal(toggleActionFor({ visible: true, minimized: false, focused: true }), "hide");
  // Hidden in the tray, minimized to the taskbar, or behind another
  // application: every one of those comes back and takes focus.
  assert.equal(toggleActionFor({ visible: false, minimized: false, focused: false }), "show");
  assert.equal(toggleActionFor({ visible: true, minimized: true, focused: true }), "show");
  assert.equal(toggleActionFor({ visible: true, minimized: false, focused: false }), "show");
});

test("the toggle hides the window instead of entering the close path", () => {
  const toggleBlock = lifecycleSource.slice(
    lifecycleSource.indexOf("function toggleMainWindow()"),
    lifecycleSource.indexOf("function updateTrayMenu"),
  );
  assert.match(toggleBlock, /windowToggleAction\(window\) === "hide"/);
  assert.match(toggleBlock, /window\.hide\(\)/);
  assert.match(toggleBlock, /restoreMainWindow\(\)/);
  // Hiding must not raise the close-behaviour prompt, destroy the window, or
  // quit: `Window.hide()` is the whole hide path.
  assert.doesNotMatch(toggleBlock, /\.close\(\)|\.destroy\(\)|app\.quit\(|quitConfirmed/);
  assert.match(lifecycleSource, /function restoreMainWindow\(\)/);
});

test("the launcher registers the toggle accelerator and nothing else", () => {
  assert.match(launcherSource, /applyToggleWindowShortcut/);
  assert.match(launcherSource, /candidate\.id === "toggleWindow"/);
  assert.match(launcherSource, /recordHostGlobalBinding\("toggleWindow", binding\)/);
  assert.match(
    launcherSource,
    /globalShortcut\.register\(accelerator, \(\) => \{\s*toggleMainWindow\(\);\s*\}\)/,
  );
  assert.match(launcherSource, /toggleWindowAccelerator/);
  assert.match(lifecycleSource, /applyToggleWindowShortcut\(keybindings\)/);
  assert.match(shutdownSource, /state\.toggleWindowAccelerator/);
  // Only the plugin launcher and the window toggle are process-wide
  // accelerators: the retired summon id is registered by nothing.
  assert.deepEqual(
    [...launcherSource.matchAll(/recordHostGlobalBinding\("([A-Za-z]+)"/g)]
      .map((match) => match[1])
      .sort(),
    ["openPluginLauncher", "toggleWindow"],
  );
  // The plugin registry refuses what the app now holds: `Alt+Space` and the
  // `Alt+Shift+W` toggle.
  assert.match(
    registrySource,
    /HOST_GLOBAL_SHORTCUT_IDS = \["openPluginLauncher", "toggleWindow"\] as const/,
  );
});

test("the shell key, the menu item, and the accelerator run one action", () => {
  assert.match(appSource, /case "toggleWindow":/);
  assert.match(appSource, /api\.nativeMenuAction\("toggleMainWindow"\)/);
  assert.match(protocolSource, /"restoreMainWindow",\s*\n\s*"toggleMainWindow",/);
  assert.match(lifecycleSource, /action === "restoreMainWindow" \|\| action === "toggleMainWindow"/);
  assert.match(menuSource, /labels\.menu\.toggleWindow/);
  assert.match(windowControlsSource, /api\.windowControl\("close"\)/);
  assert.match(menuSource, /dispatchNative\("toggleMainWindow"\)/);
  assert.doesNotMatch(menuSource, /summonWindow|closeWindow/);
});

test("stored legacy overrides are folded where each process reads them", () => {
  assert.match(lifecycleSource, /migrateKeybindingOverrides\(/);
  assert.match(storeSource, /migrateKeybindingOverrides\(settingsRaw\.keybindings\)/);
  // The cases the migration exists for: a user who customized the old close
  // key, one who customized the old summon key, a profile that froze the
  // short-lived `Mod+W` toggle default (D439), and an untouched profile.
  assert.deepEqual(migrateKeybindingOverrides({ closeWindow: "Mod+Shift+Q" }), {
    toggleWindow: "Mod+Shift+Q",
  });
  assert.deepEqual(migrateKeybindingOverrides({ summonWindow: "Ctrl+Alt+W" }), {
    toggleWindow: "Ctrl+Alt+W",
  });
  assert.deepEqual(migrateKeybindingOverrides({ toggleWindow: "Mod+W" }), undefined);
  assert.deepEqual(migrateKeybindingOverrides({ toggleWindow: "Ctrl+Alt+T" }), {
    toggleWindow: "Ctrl+Alt+T",
  });
  assert.deepEqual(migrateKeybindingOverrides({}), undefined);
});

test("settings lists one toggle row and formats it from the shared catalog", () => {
  assert.match(sectionSource, /KEYBOARD_SHORTCUTS\.filter\(\(shortcut\) => shortcut\.group === group\)/);
  assert.match(sectionSource, /resolveKeybinding\(shortcut, settings\.keybindings, platform\)/);
  assert.doesNotMatch(sectionSource, /closeWindow|summonWindow/);
  assert.match(settingsSource, /<KeyboardShortcutsSection/);
  assert.doesNotMatch(settingsSource, /closeWindow|summonWindow/);
});

test("every locale labels the merged row in both surfaces", () => {
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.notEqual(flat["menu.toggleWindow"], undefined, id);
    for (const shortcutId of KEYBOARD_SHORTCUT_IDS) {
      assert.notEqual(
        flat[`settings.shortcutAction.${shortcutId}`],
        undefined,
        `${id} settings.shortcutAction.${shortcutId}`,
      );
    }
    for (const retired of [
      "menu.closeWindow",
      "menu.summonWindow",
      "settings.shortcutAction.closeWindow",
      "settings.shortcutAction.summonWindow",
    ]) {
      assert.equal(flat[retired], undefined, `${id} ${retired}`);
    }
  }
});
