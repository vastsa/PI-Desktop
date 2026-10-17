import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  rpcTimeoutMs,
} from "@pi-desktop/shared";

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
const settingsIndex = await read("../src/lib/settings-search.ts");
const syncPage = await read("../src/components/settings/ConfigSyncPage.tsx");
const connectionFields = await read("../src/components/settings/ConfigSyncConnectionFields.tsx");
const syncPreferences = await read(
  "../src/features/settings/config-sync-preferences.ts",
);
const syncIpc = await read("../electron/main/ipc/config-sync-ipc.ts");
const styles = await loadStyles();
const syncProtocol = await read("../../../packages/shared/src/protocol.ts");
const rpcTimeouts = await read("../../../packages/shared/src/rpc-timeouts.ts");
const hostRuntime = await read("../electron/main/runtime/host.ts");
const api = await read("../src/lib/api.ts");
const progressModel = await read(
  "../src/features/settings/config-sync-progress.ts",
);
const syncError = await read(
  "../src/components/settings/ConfigSyncError.tsx",
);

test("cloud sync is Experimental and available in packaged Settings", () => {
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsIndex, /id: "sync"/);
  assert.doesNotMatch(settingsIndex, /id: "sync"[\s\S]{0,400}developmentOnly: true/);
  assert.match(settingsIndex, /experimentalBadgeKey: "settings\.configSync\.experimental"/);
  assert.match(settingsIndex, /settings\.configSync\.connectionTitle/);
  assert.match(settingsIndex, /"settings\.configSync\.experimental"/);
});

test("cloud sync keeps credentials and vault operations on the host boundary", () => {
  assert.match(syncPage, /api\.configSyncConfigure\(/);
  assert.match(syncPage, /applyState\(await api\.configSyncSyncNow\(\)\)/);
  // HTTP policy remains Host-owned; unsafe conditional-write fallback is gone.
  assert.doesNotMatch(syncPage + connectionFields, /allowInsecureHttp|appendOnly|remoteMode/);
  assert.match(connectionFields, /settings\.configSync\.modeBackup/);
  assert.match(connectionFields, /settings\.configSync\.modeSync/);
  assert.match(syncPage, /api\.configSyncUnlock\(/);
  assert.match(syncPage, /api\.configSyncMapProject\(/);
  assert.match(syncPage, /api\.configSyncListHistory\(/);
  assert.match(syncPage, /api\.configSyncRestore\(/);
  assert.match(syncPage, /api\.configSyncChangePassword\(/);
  assert.match(syncPage, /paths: paths/);
  assert.match(syncPage, /window\.confirm\(/);
  assert.doesNotMatch(syncPage, /lastVaultKey|portableApiKey|decryptedResource/);
  assert.match(syncIpc, /callHost\("configSync\.configure"/);
  assert.match(syncIpc, /callHost\("configSync\.mapProject"/);
  assert.match(syncIpc, /callHost\("configSync\.restore"/);
  assert.match(syncIpc, /callHost\("configSync\.changePassword"/);
});

test("cloud sync keeps a non-sensitive draft and paints cached state first", () => {
  assert.match(syncPage, /getCachedConfigSyncState\(\)/);
  assert.match(syncPage, /getCachedConfigSyncHistory\(\)/);
  assert.match(syncPage, /writeConfigSyncDraft\(/);
  assert.match(connectionFields, /secretSavedHint/);
  assert.doesNotMatch(syncPage, /if \(loading\) \{[\s\S]{0,180}return \(/);
  assert.match(syncPreferences, /passwords are never copied into renderer persistence/);
  assert.match(syncPreferences, /CONFIG_SYNC_DRAFT_STORAGE_KEY/);
  assert.match(syncPreferences, /saved\?: boolean/);
  assert.match(syncPreferences, /store\.setItem\(CONFIG_SYNC_DRAFT_STORAGE_KEY/);
  assert.doesNotMatch(syncPreferences, /appPassword|backupPassword/);
});

test("cloud sync settings remain usable on narrow surfaces", () => {
  assert.match(
    styles,
    /\.settings-config-sync-form,\n  \.settings-config-sync-categories \{\n    grid-template-columns: minmax\(0, 1fr\);/s,
  );
  assert.match(styles, /\.settings-config-sync-approval \{[\s\S]*flex-direction: column;/s);
});

test("a running sync reports progress across the existing host bridge", () => {
  // The sync is one request, so the report has to travel the same
  // notification path the change notice already uses.
  assert.match(
    syncProtocol,
    /configSyncProgress: "pi-desktop\/configSync\/event\/progress"/,
  );
  assert.match(
    hostRuntime,
    /method === "configSync\.progress"[\s\S]{0,400}sendToRenderer\(IPC\.event\.configSyncProgress/,
  );
  assert.match(
    api,
    /onConfigSyncProgress: \(listener: \(progress: ConfigSyncProgress\) => void\)/,
  );
});

test("the sync page follows progress while it runs a sync of its own", () => {
  // Automatic syncs stay silent, and the subscription is dropped with the page.
  assert.match(syncPage, /useEffect\(\(\) => api\.onConfigSyncProgress\(/);
  // Enabling a vault runs the same full sync as "sync now", so both gate it.
  assert.match(
    syncPage,
    /\(syncing \|\| busy === "sync" \|\| busy === "configure"\) && progress/,
  );
  // The request's own answer ends the run, so the last report is cleared when
  // it settles instead of outliving the sync it described.
  assert.match(syncPage, /setProgress\(null\);/);
});

test("the progress line renders before the status card a first enable has not built", () => {
  // The slowest sync of all is the first enable: it runs while `configured` is
  // still false, and the status card does not exist yet. So the line cannot sit
  // inside the `{configured ? …}` block that owns that card. Source order pins
  // it: the line appears exactly once, earlier than the gate.
  const marker = 'className="settings-config-sync-progress"';
  const progressAt = syncPage.indexOf(marker);
  const configuredAt = syncPage.indexOf("{configured ? (");
  assert.equal(
    syncPage.split(marker).length - 1,
    1,
    "the page renders exactly one progress line",
  );
  assert.ok(configuredAt > 0, "the configured gate is still rendered");
  assert.ok(
    progressAt > 0 && progressAt < configuredAt,
    "the progress line must render before the {configured ? …} gate",
  );
});

test("the sync card reports each phase with a readable fraction", () => {
  assert.match(syncPage, /t\(syncProgress\.phaseKey\)/);
  assert.match(syncPage, /settings\.configSync\.progressTitle/);
  assert.match(syncPage, /settings\.configSync\.progress\.objects/);
  assert.match(syncPage, /settings\.configSync\.progress\.bytes/);
  assert.match(
    progressModel,
    /import type \{ ConfigSyncPhase, ConfigSyncProgress \} from "@pi-desktop\/shared";/,
  );
  assert.match(progressModel, /^export const CONFIG_SYNC_PHASE_KEYS/m);
  for (const phase of [
    "capture",
    "download",
    "merge",
    "upload",
    "apply",
  ]) {
    assert.match(
      progressModel,
      new RegExp(`settings\\.configSync\\.progress\\.phase\\.${phase}`),
    );
  }
});

test("the sync card exposes the fraction to assistive technology", () => {
  assert.match(syncPage, /role="progressbar"/);
  assert.match(syncPage, /aria-valuemin=\{0\}/);
  assert.match(syncPage, /aria-valuemax=\{100\}/);
  assert.match(syncPage, /aria-valuenow=\{syncProgress\.percent\}/);
  assert.match(
    syncPage,
    /aria-valuetext=\{syncProgress\.fraction \?\? undefined\}/,
  );
  // A report with no announced total draws no bar: the phase name stays the
  // only status text, so the card never shows an invented fraction.
  assert.match(syncPage, /\{syncProgress\.determinate \? \(/);
  assert.match(
    styles,
    /\.settings-config-sync-progress-bar \{[\s\S]*?border-radius: var\(--radius-full\);/,
  );
  assert.match(styles, /\.settings-config-sync-progress-figures \{/);
});

test("a manual sync has no total-request RPC timeout", () => {
  assert.ok(rpcTimeouts.includes('if (method === "configSync.syncNow") return undefined;'));
  assert.equal(rpcTimeoutMs("configSync.syncNow", {}), undefined);
  assert.equal(rpcTimeoutMs("configSync.getState", {}), DEFAULT_RPC_TIMEOUT_MS);
});

test("a failed sync reads as one alert, not a stray paragraph", () => {
  // The notice is the page's error summary: announced once, with the error
  // signal carried by a single frame instead of an inline bold label.
  assert.match(
    syncError,
    /className="settings-config-sync-alert" role="alert"/,
  );
  assert.match(syncError, /<IconTriangleAlert[\s\S]{0,120}size=\{16\}/);
  assert.match(syncError, /className="settings-config-sync-alert-title"/);
  assert.match(syncError, /className="settings-config-sync-alert-text"/);
  // The raw host text stays opt-in behind the existing disclosure.
  assert.match(syncError, /className="settings-config-sync-alert-details"/);
  assert.match(
    syncError,
    /<summary>\{t\("settings\.configSync\.errorDetails"\)\}<\/summary>/,
  );
  assert.match(syncError, /<pre>\{message\}<\/pre>/);
});

test("the sync alert paints its surface from theme tokens", () => {
  assert.match(
    styles,
    /\.settings-config-sync-alert \{[\s\S]*?border: 1px solid color-mix\(in srgb, var\(--ds-error\) 30%, transparent\);[\s\S]*?background: color-mix\(in srgb, var\(--ds-error\) 8%, transparent\);/s,
  );
  assert.match(styles, /\.settings-config-sync-alert-icon \{[\s\S]*?color: var\(--ds-error\);/s);
  // The host text keeps its own plate so a long provider detail never widens
  // the notice.
  assert.match(
    styles,
    /\.settings-config-sync-alert-details > pre \{[\s\S]*?overflow-wrap: anywhere;/s,
  );
  // `--ds-danger` is defined by no theme, so the error ink it named silently
  // fell back to inherited text. Settings errors resolve through `--ds-error`.
  assert.doesNotMatch(styles, /var\(--ds-danger\)/);
  assert.match(
    styles,
    /\.settings-storage-message\.error \{\n  color: var\(--ds-error\);/,
  );
});
