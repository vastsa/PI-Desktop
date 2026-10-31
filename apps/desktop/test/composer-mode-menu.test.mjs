import assert from "node:assert/strict";
import test from "node:test";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { readComposerModule, readComposerSource } from "./helpers/source-contracts.mjs";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The operating mode is a compact chip that opens one menu. It used to advance
 * one state per click, so reaching Goal from Agent took two clicks and the two
 * other modes were never on screen; a row of three always-visible options fixed
 * the clicks but cost the toolbar a wide cluster. The chip names the committed
 * mode only, and the menu lists the three modes with their check marks.
 */

const modePicker = await readComposerModule("ComposerModePicker.tsx");
const composerSource = await readComposerSource();

async function toolbar(t, overrides = {}) {
  const ssr = await slotSsr(t);
  return (await composerToolbar(t, ssr, overrides))();
}

test("the chip opens a labelled menu instead of cycling", async (t) => {
  const html = await toolbar(t, { mode: "plan" });
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  // The trigger names the committed mode only: no other mode label in the chip.
  assert.match(html, /class="composer-mode-chip-label text-sm">settings\.modePlan</);
  // No state-advancing helper survives: the chip only opens the menu.
  assert.doesNotMatch(composerSource, /\bnextMode\b/);
  assert.match(modePicker, /menuClassName="composer-mode-menu"/);
  assert.match(modePicker, /role="menu"/);
});

test("the menu lists every mode with the committed one checked", () => {
  assert.match(modePicker, /\{MODE_CYCLE\.map\(\(candidate\) => \(/);
  assert.match(modePicker, /role="menuitemradio"/);
  assert.match(modePicker, /aria-checked=\{mode === candidate\}/);
  assert.match(modePicker, /composer-mode-menu/);
});

test("choosing a mode closes the menu and configures the active session once", () => {
  assert.match(
    modePicker,
    /onClick=\{async \(\) => \{\s*\n\s*setOpen\(false\);\s*\n\s*await onSelect\(candidate\);/,
  );
  const toolbarSource = composerSource.slice(
    composerSource.indexOf("<ComposerModePicker"),
    composerSource.indexOf("<ComposerPermissionPicker"),
  );
  assert.match(toolbarSource, /onSelect=\{async \(next\) => \{/);
  assert.match(toolbarSource, /mode: next,/);
});

test("opening one menu closes the other", () => {
  const toolbarSource = composerSource.slice(
    composerSource.indexOf("<ComposerModePicker"),
    composerSource.indexOf('<div className="composer-right">'),
  );
  assert.match(
    toolbarSource,
    /onCloseOtherMenus=\{\(\) => \{\s*\n\s*modelMenu\.setOpen\(false\);\s*\n\s*setPermissionOpen\(false\);/,
  );
  assert.match(
    toolbarSource,
    /onCloseOtherMenus=\{\(\) => \{\s*\n\s*modelMenu\.setOpen\(false\);\s*\n\s*setModeOpen\(false\);/,
  );
  // A blocked composer closes both menus, not just the approval one.
  assert.match(composerSource, /setModeOpen\(false\);\s*\n\s*setPermissionOpen\(false\);/);
});
