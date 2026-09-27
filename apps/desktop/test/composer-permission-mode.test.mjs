import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

test("Agent and Plan permission menus present only effective selectable modes", () => {
  const permissionControlSource = composerSource.slice(
    composerSource.indexOf('<div className="composer-permission"'),
    composerSource.indexOf('<div className="composer-right">'),
  );

  assert.match(
    permissionControlSource,
    /\["ask", "accept-edits", "auto"\] as const/,
  );
  assert.match(
    permissionControlSource,
    /aria-checked=\{composerPermissionMode === candidate\}/,
  );
  assert.match(
    permissionControlSource,
    /\{t\(PERMISSION_MODE_I18N_KEYS\[candidate\]\)\}/,
  );
  assert.doesNotMatch(permissionControlSource, /permissionInherit/);
  assert.doesNotMatch(permissionControlSource, /\["inherit",/);
});

test("Goal keeps the permission chip visible but fixes it to Full auto", () => {
  const permissionControlSource = composerSource.slice(
    composerSource.indexOf('<div className="composer-permission"'),
    composerSource.indexOf('<div className="composer-right">'),
  );

  assert.match(
    composerSource,
    /const composerPermissionMode: Exclude<PermissionMode, "inherit"> =\s*\n\s*mode === "goal" \? "auto" : effectivePermissionMode;/,
  );
  assert.match(permissionControlSource, /mode === "goal" \? undefined : "menu"/);
  assert.match(permissionControlSource, /disabled=\{controlsBlocked \|\| mode === "goal"\}/);
  assert.match(permissionControlSource, /permissionOpen && mode !== "goal"/);
});
