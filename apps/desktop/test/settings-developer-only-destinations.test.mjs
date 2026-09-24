/**
 * Developer-only settings destinations contract.
 *
 * Cloud sync and Remote Hosts are experimental surfaces that exist only while
 * developer mode is on. The rail, page, and settings search must add and drop
 * them together, and a stale selection must fall back to General instead of
 * rendering a page the rail no longer offers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;

test("developer mode alone decides which destinations exist", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  assert.equal(off.includes("sync"), false);
  assert.equal(on.includes("sync"), true);
  assert.equal(off.includes("remoteHosts"), false);
  assert.equal(on.includes("remoteHosts"), true);
  assert.deepEqual(
    off,
    on.filter((id) => id !== "sync" && id !== "remoteHosts"),
  );
  // Both gated destinations carry the badge rendered by the rail and title.
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    ["sync", "remoteHosts"],
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "sync")?.experimentalBadgeKey,
    "settings.configSync.experimental",
  );
});

test("settings search mirrors the rail", () => {
  assert.deepEqual(
    searchSettings("configSync.connectionTitle", identity, { developerMode: false }),
    [],
  );
  assert.ok(
    searchSettings("configSync.connectionTitle", identity, { developerMode: true })
      .some((hit) => hit.tab === "sync"),
  );
  assert.deepEqual(searchSettings("remotehosts", identity, { developerMode: false }), []);
  const hits = searchSettings("remotehosts", identity, { developerMode: true });
  assert.ok(hits.some((hit) => hit.tab === "remoteHosts"));
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("a stale developer-only selection is reported as hidden", () => {
  assert.equal(isSettingsDestinationHidden("sync", false), true);
  assert.equal(isSettingsDestinationHidden("sync", true), false);
  assert.equal(isSettingsDestinationHidden("remoteHosts", false), true);
  assert.equal(isSettingsDestinationHidden("remoteHosts", true), false);
  assert.equal(isSettingsDestinationHidden("general", false), false);
});

test("the rail, the page, and the search dialog follow developer mode", () => {
  assert.match(settingsPage, /const developerMode = settings\?\.developerMode === true/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\(tab, developerMode\)/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /item\.experimentalBadgeKey/);
  assert.match(settingsPage, /activeNavItem\?\.experimentalBadgeKey/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /searchSettings\(query, t, \{ developerMode \}\)/);
});
