import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { composerPermissionState } = await import("../src/features/chat/composer/model.ts");
const permissionControlSource = await readComposerModule("ComposerPermissionPicker.tsx");
const toolbarSource = await readComposerModule("ComposerToolbar.tsx");

test("Agent and Plan permission menus present only effective selectable modes", () => {
  const optionsSource = permissionControlSource.slice(
    permissionControlSource.indexOf('(["ask", "accept-edits", "auto"] as const).map'),
    permissionControlSource.indexOf('{hasActiveSession && mode !== "goal"'),
  );

  assert.match(
    optionsSource,
    /\["ask", "accept-edits", "auto"\] as const/,
  );
  assert.match(
    optionsSource,
    /aria-checked=\{composerPermissionMode === candidate\}/,
  );
  assert.match(
    optionsSource,
    /\{t\(PERMISSION_MODE_I18N_KEYS\[candidate\]\)\}/,
  );
  assert.doesNotMatch(optionsSource, /permissionInherit|\["inherit",/);
  assert.match(permissionControlSource, /\["inherit", "user", "auto_review"\] as const/,
    "reviewer inheritance remains a separate setting, not a permission mode");
  for (const mode of ["agent", "plan"]) {
    assert.equal(composerPermissionState({ mode, session: { permissionMode: "inherit" },
      globalPermissionMode: "accept-edits" }).permissionMode, "accept-edits");
  }
});

test("Goal keeps the permission chip visible but fixes it to Full auto", () => {
  assert.equal(composerPermissionState({ mode: "goal", session: { permissionMode: "ask" },
    globalPermissionMode: "ask" }).permissionMode, "auto");
  assert.match(toolbarSource, /<ComposerPermissionPicker t=\{t\} mode=\{mode\}/);
  assert.match(permissionControlSource, /PERMISSION_MODE_I18N_KEYS\[composerPermissionMode\]/);
  assert.match(permissionControlSource, /mode === "goal" \? undefined : "menu"/);
  assert.match(permissionControlSource, /disabled=\{controlsBlocked \|\| mode === "goal"\}/);
  assert.match(permissionControlSource, /permissionOpen && mode !== "goal"/);
});
