import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource =
  (await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8")) +
  (await readFile(new URL("../src/components/SidebarNavigation.tsx", import.meta.url), "utf8"));
const footerSource = sidebarSource.slice(sidebarSource.indexOf("export function SidebarFooter"));
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the sidebar footer is an action bar, not a fabricated identity", () => {
  // The app has no accounts; an avatar with a name implied one that never existed.
  assert.doesNotMatch(sidebarSource, /footer-profile/);
  assert.doesNotMatch(sidebarSource, /profile-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar-profile-menu/);
  assert.doesNotMatch(sidebarSource, /IconUser/);
  assert.doesNotMatch(globalStyles, /\.footer-profile/);
  assert.doesNotMatch(globalStyles, /\.profile-menu/);
  for (const locale of [zhLocale, enLocale]) {
    assert.doesNotMatch(locale, /localProfile:/);
    assert.doesNotMatch(locale, /openProfileMenu:/);
  }
});

test("footer keeps only Settings and the version chip", () => {
  assert.deepEqual(
    [...footerSource.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]),
    ["settings", "build"],
  );
  // Settings is a labelled entry that opens the Settings dialog.
  assert.match(footerSource, /className=\{cx\("footer-settings", settingsOpen && "active"\)\}/);
  assert.match(footerSource, /aria-haspopup="dialog"/);
  assert.match(footerSource, /onClick=\{\(\) => openSettings\(\)\}/);
  assert.match(footerSource, /t\("nav\.settings"\)/);
  // The notification entry is gone from the sidebar (issue #2431).
  assert.doesNotMatch(sidebarSource, /NotificationCenter/);
  // Logs live in Settings → About; the footer stays down to daily controls.
  assert.doesNotMatch(sidebarSource, /openLogs/);
});

test("footer sits on the sidebar content grid without a hairline", () => {
  const block = globalStyles.match(/\.sidebar-footer\s*\{[^}]+\}/)?.[0] ?? "";
  // Zero side padding keeps the chip text and trailing icon aligned with the
  // nav rows that .sidebar-body already insets by 8px. D297: the footer is set
  // apart from the nav by `margin-top: auto` and its own padding, not a rule.
  assert.match(block, /padding:\s*7px 0 2px/);
  assert.doesNotMatch(block, /border-top/);
  assert.match(globalStyles, /\.footer-build\s*\{[^}]*padding:\s*5px 8px/s);
});

test("footer Settings entry shares the 32px control line", () => {
  const block = globalStyles.match(/\.footer-settings\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /height:\s*32px/);
  assert.match(block, /transition:[^;]*var\(--motion-duration-fast\)/);
  assert.doesNotMatch(globalStyles, /\.footer-action\s*\{/);
});

test("build chip surfaces the version and only dots an actionable update", () => {
  assert.match(sidebarSource, /const update = useUpdateState\(\)/);
  assert.match(
    sidebarSource,
    /update\?\.status === "available" \|\| update\?\.status === "downloaded"/,
  );
  assert.match(sidebarSource, /className="footer-build-dot"/);
  // An actionable update routes to the Settings row that can act on it.
  assert.match(sidebarSource, /setSettingsAnchor\("updates\.title"\)/);
  assert.match(sidebarSource, /setSettingsTab\("about"\)/);
  assert.match(sidebarSource, /api\.updatesCheck\(\)/);
  const dot = globalStyles.match(/\.footer-build-dot\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(dot, /background:\s*var\(--ds-accent\)/);
});
