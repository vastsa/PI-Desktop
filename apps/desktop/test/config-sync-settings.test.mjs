import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
const settingsIndex = await read("../src/lib/settings-search.ts");
const syncPage = await read("../src/components/settings/ConfigSyncPage.tsx");
const syncIpc = await read("../electron/main/ipc/config-sync-ipc.ts");
const styles = await loadStyles();

test("cloud sync is a searchable settings destination", () => {
  assert.match(settingsPage, /tab === "sync" && <ConfigSyncPage \/>/);
  assert.match(settingsIndex, /id: "sync"/);
  assert.match(settingsIndex, /settings\.configSync\.connectionTitle/);
});

test("cloud sync keeps credentials and vault operations on the host boundary", () => {
  assert.match(syncPage, /api\.configSyncConfigure\(/);
  assert.match(syncPage, /setState\(await api\.configSyncSyncNow\(\)\)/);
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
