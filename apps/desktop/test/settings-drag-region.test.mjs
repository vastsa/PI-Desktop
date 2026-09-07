import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsSource = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("settings exposes a native drag region over the content column", () => {
  assert.match(
    settingsSource,
    /<div className="settings-titlebar" aria-hidden="true" \/>/,
  );
  assert.match(
    globalStyles,
    /\.settings-titlebar\s*\{[^}]*height:\s*var\(--ds-toolbar-height\);[^}]*background:\s*var\(--ds-bg-primary\);[^}]*border-bottom:\s*0;[^}]*-webkit-app-region:\s*drag;/s,
  );
});

test("settings drag band stops at the nav rail so surfaces stay consistent", () => {
  // The band paints --ds-bg-primary. Spanning the full window width laid that
  // surface over the rail's own tone, so the strip above the rail no longer
  // matched the rail beneath it.
  // Anchor to the base rule; platform overrides also mention the class.
  const band = /\n\.settings-titlebar\s*\{([^}]*)\}/s.exec(globalStyles);
  assert.ok(band, "expected a .settings-titlebar rule");
  assert.match(band[1], /left:\s*var\(--ds-settings-nav-width\);/);
  assert.match(band[1], /right:\s*0;/);
  assert.doesNotMatch(band[1], /inset-inline:\s*0;/);
  // Physical insets keep chrome.css's `right` override winning on specificity;
  // a logical inset here would instead win on declaration order and push the
  // band under the Windows/Linux window-control capsule.
  assert.doesNotMatch(band[1], /inset-inline-end:/);

  // Rail and band must read the same width token or the seam drifts apart.
  assert.match(
    globalStyles,
    /\.settings-shell-full \.settings-nav\s*\{[^}]*width:\s*var\(--ds-settings-nav-width\);[^}]*flex:\s*0 0 var\(--ds-settings-nav-width\);/s,
  );
  assert.match(globalStyles, /--ds-settings-nav-width:\s*275px;/);

  // The rail still drags the window even though the band no longer covers it.
  assert.match(settingsSource, /className="settings-nav-top drag"/);
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
