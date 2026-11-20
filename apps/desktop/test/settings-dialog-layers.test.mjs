import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const zIndex = (styles, selector) => {
  // The selector may lead or sit inside a selector list.
  const escaped = selector.replace(/\./g, "\\.");
  const block = styles.match(new RegExp(`\\n${escaped}(?:,[^{]*)?\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Number(block.match(/z-index:\s*(\d+)/)?.[1]);
};

test("menus opened inside the Settings dialog mount above it", async () => {
  const [portal, settingsDialog, guide, anchoredMenu, styles] = await Promise.all([
    read("../src/lib/portal-visibility.tsx"),
    read("../src/features/settings/SettingsDialog.tsx"),
    read("../src/features/startup/StartupGuideDialog.tsx"),
    read("../src/components/settings/AnchoredMenu.tsx"),
    loadStyles(),
  ]);
  // Body-level layers follow the enclosing modal's layer host.
  assert.match(portal, /createPortal\(visiblePortalContent\(node\), host \?\? document\.body\)/);
  assert.match(portal, /className="modal-layer-host"/);
  // Both modals that embed Settings destinations provide that host.
  for (const dialog of [settingsDialog, guide]) {
    assert.match(dialog, /portalOverlay\(\s*<ModalLayer>/);
  }
  assert.match(anchoredMenu, /portalToBody\(/);
  // The host stacks above the dialog layer and never eats clicks itself.
  const host = zIndex(styles, ".modal-layer-host");
  assert.ok(host > zIndex(styles, ".settings-dialog-overlay"), `host z ${host}`);
  assert.ok(host > zIndex(styles, ".startup-guide-overlay"), `host z ${host}`);
  assert.match(styles, /\.modal-layer-host\s*\{[^}]*pointer-events:\s*none;/);
  assert.match(styles, /\.modal-layer-host > \*\s*\{\s*pointer-events:\s*auto;/);
});

test("nothing reachable from Settings portals straight to document.body", async () => {
  const roots = ["../src/components/settings/", "../src/features/settings/"];
  const files = [
    "../src/components/ProjectInstructionsDialog.tsx",
    "../src/components/ProjectMemoryDialog.tsx",
  ];
  for (const root of roots) {
    for (const entry of await readdir(new URL(root, import.meta.url), { recursive: true })) {
      if (/\.tsx?$/.test(entry)) files.push(root + entry);
    }
  }
  for (const file of files) {
    assert.doesNotMatch(await read(file), /createPortal\([\s\S]*?document\.body\)/, file);
  }
});
