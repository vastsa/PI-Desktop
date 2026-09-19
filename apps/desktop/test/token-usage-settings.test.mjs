import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);

// D335 / ADR 0173 stands, and the #478 call settles the follow-up: the dashboard
// ships as the pi.token-insights plugin, so the whole stats UI layer is gone
// from the app. Core keeps the turns / usage / stats RPCs and their shared
// types — that is the surface a plugin calls.
//
// This guards the boundary in both directions. It fails if the usage
// destination quietly creeps back into the sidebar or its copy resurfaces in
// the catalogs, and it fails if the stats RPCs the plugin depends on get
// swept away as dead code.
test("usage statistics is not a settings destination", () => {
  assert.doesNotMatch(search, /id: "usage"/);
  assert.doesNotMatch(search, /settings\.nav\.usage/);
  assert.doesNotMatch(search, /settings\.groupData/);
  assert.doesNotMatch(settingsPage, /StatsPage/);
  assert.doesNotMatch(settingsPage, /tab === "usage"/);
  // The retired page's scope wrapper must not survive as a stray route or
  // stylesheet hook.
  assert.doesNotMatch(settingsPage, /stats-scope/);
});

test("the stats UI layer stays deleted while the RPCs ship separately", () => {
  // The dashboard is plugin-owned (issue #478): no first-party page component
  // may come back for a plugin to "reuse" — a plugin cannot import app
  // internals and ships its own UI.
  assert.doesNotMatch(settingsPage, /stats/);
  // The summary/topSessions RPC surface ships in its own change (see the
  // review thread), so this PR carries neither the RPCs nor their typings.
  assert.doesNotMatch(api, /statsSummary/);
  assert.doesNotMatch(api, /statsTopSessions/);
});

test("the locale bundles carry no usage-dashboard copy", () => {
  for (const catalog of [enLocale, zhLocale]) {
    assert.doesNotMatch(catalog, /"?groupData"?:/);
    assert.doesNotMatch(catalog, /^ {4}"?usage"?:/m);
    assert.doesNotMatch(catalog, /^ {2}"?stats"?: \{/m);
    // The one-time note lives on the index page under its own keys now.
    assert.match(catalog, /nudgeText:/);
    assert.match(catalog, /nudgeDismiss:/);
  }
});
