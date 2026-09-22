import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const overlaySources = [
  "../src/components/settings/ProviderSetupDialog.tsx",
  "../src/components/settings/VendorAccountDialog.tsx",
  "../src/components/settings/VendorPickerDialog.tsx",
  "../src/components/settings/OAuthLoginDialog.tsx",
  "../src/components/settings/SkillEditorSheet.tsx",
  "../src/components/settings/SubagentEditorSheet.tsx",
  "../src/components/extensions/McpEditorSheet.tsx",
];

test("route entrance does not leave a transform containing block", async () => {
  const styles = await loadStyles();
  const start = styles.indexOf("@keyframes route-surface-in");
  assert.notEqual(start, -1, "missing @keyframes route-surface-in");
  const next = styles.indexOf("@keyframes", start + 1);
  const block = styles.slice(start, next === -1 ? undefined : next);
  assert.doesNotMatch(block, /transform:/);
  assert.match(block, /opacity:\s*0/);
  assert.doesNotMatch(
    styles,
    /\.route-surface,\s*\.settings-content-inner\s*\{[^}]*animation:\s*route-surface-in/,
  );
  // No fill either: the entrance ends on the element's own state, so a fill
  // would only keep the animation in effect — and with it the stacking context
  // that left route-level overlays (the plugin modals, the plugin detail
  // sheet) underneath the opaque titlebar band.
  const entrance = styles.match(
    /\.route-surface,\n\.settings-content-enter \{[^}]*\}/,
  );
  assert.ok(entrance, "missing the route entrance rule");
  const animation = entrance[0].match(/animation:[^;]*;/);
  assert.ok(animation, "missing the route entrance animation");
  assert.doesNotMatch(animation[0], /\bboth\b|\bforwards\b/);
});

test("settings overlays mount on a viewport-fixed host outside the app shell", async () => {
  const styles = await loadStyles();
  assert.match(styles, /\n\.overlay \{\n  position: fixed;\n  inset: 0;/);

  const host = styles.match(/#pi-desktop-overlays \{[\s\S]*?\n\}/);
  assert.ok(host, "missing overlay host rule");
  assert.match(host[0], /position:\s*fixed/);
  assert.match(host[0], /inset:\s*0/);

  const ui = await read("../src/components/ui.tsx");
  assert.match(ui, /export function portalOverlay/);
  assert.match(ui, /pi-desktop-overlays/);
  assert.match(ui, /document\.documentElement\.appendChild/);
  assert.doesNotMatch(ui, /createPortal\(node, document\.body\)/);

  for (const rel of overlaySources) {
    const source = await read(rel);
    assert.match(source, /portalOverlay\(/, `${rel} must portal its overlay`);
  }
});

// A route overlay is no longer trapped under the window chrome (see the
// entrance-fill assertion above), which puts it back in the root stacking
// context with its own z-index. Everything a dialog raises from inside itself —
// a select list, a toast — is portaled to `document.body` and therefore sits in
// that same context, so it must out-rank the overlay that spawned it or it
// lands underneath the scrim and stops taking clicks.
test("leaf popups and toasts keep painting above the route overlays", async () => {
  const styles = await loadStyles();
  const layer = (selector) => {
    const block = styles.match(new RegExp(`(?:^|\\n)${selector} \\{[^}]*\\}`));
    assert.ok(block, `missing ${selector}`);
    const value = block[0].match(/z-index:\s*(\d+)/);
    assert.ok(value, `${selector} states no z-index`);
    return Number(value[1]);
  };

  const veil = layer("\\.plugins-modal-backdrop");
  const sheet = layer("\\.plugins-sheet-layer");
  const notes = layer("\\.release-notes-overlay");
  const toast = layer("\\.toast-viewport");
  const selectMenu = layer("\\.settings-menu-select-menu");

  for (const [name, value] of [
    ["plugins-modal-backdrop", veil],
    ["plugins-sheet-layer", sheet],
    ["release-notes-overlay", notes],
  ]) {
    assert.ok(value <= 40, `${name} must sit on z-dialog (40), not ${value}`);
  }
  assert.ok(selectMenu > veil && selectMenu > sheet && selectMenu > notes);
  assert.ok(toast > veil && toast > sheet && toast > notes);
});

// The scenic backdrop stays the app shell's only layered child. A z-index on
// any shell sibling that contains a route overlay (`.main-pane`, `.sidebar`)
// re-creates the stacking context the entrance rule above exists to avoid, and
// the overlay sinks below the window chrome again.
test("app shell children never trap a route overlay in a stacking context", async () => {
  const baseSrc = await read("../src/styles/base.css");
  assert.doesNotMatch(baseSrc, /\.app-shell\s*>\s*:\s*not\(/);
  for (const selector of [".main-pane", ".sidebar", ".work-panel"]) {
    const escaped = selector.replace(".", "\\.");
    const block = baseSrc.match(new RegExp(`(?:^|\\n)${escaped} \\{[^}]*\\}`));
    assert.ok(
      !block || !/z-index:/.test(block[0]),
      `${selector} must not state a z-index in base.css`,
    );
  }
});
