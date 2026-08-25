import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsSource = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("settings exposes a full-width native drag region", () => {
  assert.match(
    settingsSource,
    /<div className="settings-titlebar" aria-hidden="true" \/>/,
  );
  assert.match(
    globalStyles,
    /\.settings-titlebar\s*\{[^}]*height:\s*var\(--ds-toolbar-height\);[^}]*background:\s*var\(--ds-bg-primary\);[^}]*border-bottom:\s*1px solid var\(--ds-border-subtle\);[^}]*-webkit-app-region:\s*drag;/s,
  );
});

test("settings drag region does not capture control clicks", () => {
  assert.match(
    globalStyles,
    /\.settings-titlebar\s*\{[^}]*pointer-events:\s*none;/s,
  );
  assert.match(settingsSource, /className="settings-back no-drag"/);
  assert.match(settingsSource, /className="settings-search-wrap no-drag"/);
  assert.match(settingsSource, /className="settings-nav-scroll no-drag"/);
});
