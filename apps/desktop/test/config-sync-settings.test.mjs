import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import {
  CONFIG_SYNC_RPC_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  rpcTimeoutMs,
} from "@pi-desktop/shared";

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
const settingsIndex = await read("../src/lib/settings-search.ts");
const syncPage = await read("../src/components/settings/ConfigSyncPage.tsx");
const syncIpc = await read("../electron/main/ipc/config-sync-ipc.ts");
const styles = await loadStyles();
const syncProtocol = await read("../../../packages/shared/src/protocol.ts");
const rpcTimeouts = await read("../../../packages/shared/src/rpc-timeouts.ts");
const hostRuntime = await read("../electron/main/runtime/host.ts");
const api = await read("../src/lib/api.ts");
const progressModel = await read(
  "../src/features/settings/config-sync-progress.ts",
);

test("cloud sync rendering follows the settings visibility gate", () => {
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsIndex, /id: "sync"/);
  assert.match(settingsIndex, /experimentalBadgeKey: "settings\.configSync\.experimental"/);
  assert.match(settingsIndex, /settings\.configSync\.connectionTitle/);
});

test("cloud sync keeps credentials and vault operations on the host boundary", () => {
  assert.match(syncPage, /api\.configSyncConfigure\(/);
  assert.match(syncPage, /setState\(await api\.configSyncSyncNow\(\)\)/);
  // The plaintext opt-in is the network mode now, not a WebDAV switch: the page
  // carries no per-endpoint HTTP acknowledgement of its own.
  assert.doesNotMatch(syncPage, /allowInsecureHttp/);
  assert.match(syncPage, /settings\.configSync\.remoteMode/);
  assert.match(syncPage, /settings\.configSync\.appendOnlyWarning/);
  assert.match(syncPage, /settings\.configSync\.appendOnlyConfirm/);
  assert.match(syncPage, /remoteMode/);
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
    /\(busy === "sync" \|\| busy === "configure"\) && progress/,
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
    "cleanup",
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

test("a manual sync outlasts the flat default transport deadline", () => {
  // The host cannot cancel a run that is already under way, so a deadline that
  // fires while it is still working would only report a failure that is not
  // one; the report events carry liveness instead.
  assert.match(rpcTimeouts, /CONFIG_SYNC_RPC_TIMEOUT_MS = 1_800_000/);
  assert.match(rpcTimeouts, /method === "configSync\.syncNow"/);
  assert.equal(rpcTimeoutMs("configSync.syncNow", {}), CONFIG_SYNC_RPC_TIMEOUT_MS);
  assert.ok(CONFIG_SYNC_RPC_TIMEOUT_MS > DEFAULT_RPC_TIMEOUT_MS);
  // Every other config-sync call keeps the shared default.
  assert.equal(rpcTimeoutMs("configSync.getState", {}), DEFAULT_RPC_TIMEOUT_MS);
});
