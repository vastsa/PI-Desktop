import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [search, settingsPage, api, protocol, main, page, enLocale, settingsTypes, statsTypes] = await Promise.all([
  read("src/lib/settings-search.ts"),
  read("src/features/settings/SettingsPage.tsx"),
  read("src/lib/api.ts"),
  read("../../packages/shared/src/protocol.ts"),
  read("electron/main/ipc/session-ipc.ts"),
  read("src/components/settings/IndexPage.tsx"),
  read("../../packages/i18n/src/locales/en/index.ts"),
  read("../../packages/shared/src/types/settings.ts"),
  read("../../packages/shared/src/types/workspace-index.ts"),
]);

test("workspace index is a workspace-group settings destination", () => {
  assert.match(search, /id: "index"/);
  assert.match(search, /labelKey: "settings\.nav\.index"/);
  assert.match(search, /workspace: "settings\.groupWorkspace"/);
  assert.match(search, /titleKey: "settings\.index"/);
  // The index sits in Workspace, not in a group of its own (D335 / ADR 0173):
  // the switch, its status and the rebuild/clear actions are host/workspace
  // lifecycle, which is what that group already collects. The retired Data &
  // Statistics group must not reappear as a one-entry section.
  assert.doesNotMatch(search, /settings\.groupData/);
  assert.doesNotMatch(search, /group: "data"/);
  const entry = search.slice(
    search.indexOf('id: "index"'),
    search.indexOf('id: "about"'),
  );
  assert.match(entry, /group: "workspace"/);
  assert.match(entry, /"index\.card\.health"/);
  assert.match(settingsPage, /tab === "index" && settings && \(\n\s*<IndexPage settings=\{settings\} saveSettings=\{saveSettings\} \/>\n\s*\)/);
  assert.match(settingsPage, /import \{ IndexPage \}/);
});

test("index page drives one switch and keeps the index a rebuildable cache", async () => {
  await access(
    new URL("../src/components/settings/IndexPage.tsx", import.meta.url),
    constants.F_OK,
  );
  assert.match(page, /api\.indexStatus\(/);
  assert.match(page, /api\.indexRebuild\(/);
  assert.match(page, /api\.indexClear\(/);
  assert.match(page, /index\.card\.health/);
  assert.match(page, /settings\.indexGrepBoost === true/);
  assert.match(page, /saveSettings\(\{ indexGrepBoost: !grepBoost \}\)/);
  assert.match(page, /setInterval\(poll, 1000\)/);
  assert.match(page, /index\.status\.\$\{root\.status\}/);
  // One switch owns the index lifecycle. A second "index new folders" toggle
  // could only duplicate this one or build an index that nothing uses.
  assert.equal(page.match(/role="switch"/g)?.length, 1);
  assert.doesNotMatch(page, /indexNewFolders/);
  assert.doesNotMatch(settingsTypes, /indexNewFolders/);
  assert.doesNotMatch(enLocale, /newFolders/);
  assert.match(enLocale, /grepBoost: "Workspace indexing"/);
  assert.match(enLocale, /grepBoostDesc: "While this switch is on, newly opened workspaces are indexed/);
  // The copy describes the index as what it is: a rebuildable local cache.
  assert.match(enLocale, /statusDesc: "The index is a rebuildable local cache\."/);
  // The manual build is gated on that same switch: without a consumer an index
  // is only a scan and some disk, so the page must not offer to build one.
  assert.match(page, /disabled=\{busy !== null \|\| !grepBoost\}/);
  assert.match(page, /aria-describedby="idx-actions-desc"/);
  assert.match(enLocale, /actionsDesc: "Build or rebuild the index for the current workspace/);
  assert.match(enLocale, /cannot be built while the switch is off/);
});

test("index IPC stays on the three lifecycle channels", () => {
  assert.match(protocol, /indexStatus: "pi-desktop\/index\/status"/);
  assert.match(protocol, /indexRebuild: "pi-desktop\/index\/rebuild"/);
  assert.match(protocol, /indexClear: "pi-desktop\/index\/clear"/);
  assert.match(api, /indexStatus: \(rootPath\?: string\)/);
  assert.match(api, /indexRebuild: \(rootPath\?: string\)/);
  assert.match(api, /indexClear: \(rootPath\?: string\)/);
  assert.match(main, /host\.call\("index\.status", input \?\? \{\}\)/);
  assert.match(main, /host\.call\("index\.rebuild", input \?\? \{\}\)/);
  assert.match(main, /host\.call\("index\.clear", input \?\? \{\}\)/);
});

test("settings search and locales carry the index keys", () => {
  for (const key of [
    "settings.nav.index",
    "settings.index",
    "index.card.health",
    "index.action.rebuild",
    "index.action.clear",
  ]) {
    const leaf = key.split(".").pop();
    assert.match(enLocale, new RegExp(`${leaf}:`));
  }
});

test("index page surfaces the host's rebuild progress", () => {
  assert.match(page, /className="idx-progress"/);
  assert.match(page, /className="idx-progress-fill"/);
  assert.match(page, /t\("index\.progressFiles", \{/);
  assert.match(page, /t\("index\.progressFallback"\)/);
  // The host gives no counts: an indeterminate pill, never a fake bar.
  assert.match(page, /t\("index\.status\.building"\)/);
});

test("the index page explains itself once and can be dismissed for good", () => {
  // Once written, the flag keeps the note away for every later render.
  assert.match(page, /const NUDGE_DISMISSED_KEY = /);
  assert.match(page, /localStorage\.getItem\(NUDGE_DISMISSED_KEY\) !== "1"/);
  assert.match(page, /localStorage\.setItem\(NUDGE_DISMISSED_KEY, "1"\)/);
  assert.match(page, /t\("index\.nudgeText"\)/);
  assert.match(page, /t\("index\.nudgeDismiss"\)/);
  // The switch left the health card: it is a setting, not telemetry.
  assert.match(page, /t\("index\.sectionCode"\)/);
  assert.match(page, /t\("index\.indexSubtitle"\)/);
});

test("the manual build is gated on the index switch", async () => {
  // Rebuild stays a host lifecycle RPC and keeps working regardless, but the
  // page only offers it while the opt-in switch is on: an index nothing uses
  // is pure scan and disk cost, which is the reason the card carries exactly
  // one toggle in the first place.
  assert.match(page, /t\("index\.actionsDesc"\)/);
  assert.match(page, /t\("index\.localOnly"\)/);
  assert.match(page, /id="idx-actions-desc"/);
  // Clear keeps working with the switch off, so a leftover index can still go.
  assert.match(page, /disabled=\{busy !== null \|\| !root\}/);
  // The gate lives in the locale, not only in the component: every shipped
  // catalog has to say why the build can be unavailable.
  for (const locale of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr"]) {
    const catalog = await read(`../../packages/i18n/src/locales/${locale}/index.ts`);
    assert.match(catalog, /"?actionsDesc"?:/, locale);
  }
});
