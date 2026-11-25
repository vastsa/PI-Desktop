import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsSource = await readSettingsSource();
const globalStyles = await loadStyles();

test("the Settings dialog owns no window drag region", () => {
  // Settings is a modal over the shell; the shell keeps its own titlebar drag
  // band, so the dialog must not add one that would swallow control clicks.
  assert.doesNotMatch(settingsSource, /settings-titlebar/);
  assert.doesNotMatch(settingsSource, /className="[^"]*\bdrag\b[^"]*"/);
  assert.doesNotMatch(globalStyles, /\.settings-titlebar\b/);
});

test("the Settings rail keeps the shared width token", () => {
  assert.match(
    globalStyles,
    /\.settings-shell-full \.settings-nav\s*\{[^}]*width:\s*var\(--ds-settings-nav-width\);[^}]*flex:\s*0 0 var\(--ds-settings-nav-width\);/s,
  );
  assert.match(globalStyles, /--ds-settings-nav-width:\s*275px;/);
});
