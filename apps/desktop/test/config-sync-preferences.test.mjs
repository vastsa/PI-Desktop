import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/features/settings/config-sync-preferences.ts", import.meta.url),
  "utf8",
);
const require = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { transform } = require("esbuild");
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const preferences = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);

function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const connection = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "private-config",
  prefix: "pi-desktop/config",
  accessKeyId: "test-access-id",
  pathStyle: true,
  mode: "sync",
};
const entries = [{ revisionId: "revision-a", current: true }];

test("S3 draft round-trips only typed non-sensitive choices", () => {
  const store = fakeStorage();
  const draft = {
    ...connection,
    deviceLabel: "MacBook",
    automaticSync: false,
    categories: { providers: true, credentials: false },
    saved: false,
  };
  preferences.writeConfigSyncDraft({
    ...draft,
    secretAccessKey: "never-persist-secret",
    sessionToken: "never-persist-token",
    backupPassword: "never-persist-password",
    currentBackupPassword: "never-persist-current",
    newBackupPassword: "never-persist-new",
  }, store);
  const raw = store.values.get(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY);
  assert.doesNotMatch(raw, /never-persist|secretAccessKey|sessionToken|[Pp]assword/);
  assert.deepEqual(preferences.readConfigSyncDraft(store), draft);
});

test("old WebDAV drafts are ignored and left untouched", () => {
  const store = fakeStorage();
  const legacy = JSON.stringify({ endpoint: "https://dav.example.com", username: "alice", directory: "old" });
  store.setItem("pi.desktop.configSyncDraft", legacy);
  assert.deepEqual(preferences.readConfigSyncDraft(store), {});
  preferences.clearConfigSyncDraft(store);
  assert.equal(store.getItem("pi.desktop.configSyncDraft"), legacy);
});

test("draft rejects malformed fields and strips injected credentials on read", () => {
  const store = fakeStorage();
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, JSON.stringify({
    endpoint: "x".repeat(2049), mode: "unsafe", pathStyle: "yes",
    categories: { providers: "yes", mcp: true }, saved: "no",
    secretAccessKey: "hidden", sessionToken: "hidden",
  }));
  assert.deepEqual(preferences.readConfigSyncDraft(store), { categories: { mcp: true } });
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, "{");
  assert.deepEqual(preferences.readConfigSyncDraft(store), {});
});

test("history expires and connection or mode changes invalidate it immediately", () => {
  preferences.cacheConfigSyncState({ ...connection, configured: true });
  preferences.cacheConfigSyncHistory(entries, 1000);
  assert.equal(preferences.hasFreshConfigSyncHistory(1000), true);
  assert.equal(preferences.hasFreshConfigSyncHistory(1000 + preferences.CONFIG_SYNC_HISTORY_CACHE_TTL_MS), false);
  preferences.cacheConfigSyncState({ ...connection, configured: true, status: "syncing" });
  assert.deepEqual(preferences.getCachedConfigSyncHistory(), entries);
  for (const [field, value] of Object.entries({
    endpoint: "https://other.example.com", region: "eu-west-1", bucket: "other-bucket",
    prefix: "other-prefix", accessKeyId: "other-id", pathStyle: false, mode: "backup", configured: false,
  })) {
    preferences.cacheConfigSyncState({ ...connection, configured: true });
    preferences.cacheConfigSyncHistory(entries, 1000);
    assert.equal(preferences.cacheConfigSyncState({ ...connection, configured: true, [field]: value }), true);
    assert.deepEqual(preferences.getCachedConfigSyncHistory(), [], field);
    assert.equal(preferences.hasFreshConfigSyncHistory(1000), false, field);
  }
});

test("legacy project selection is discarded on draft read and write", () => {
  const store = fakeStorage();
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, JSON.stringify({
    ...connection, categories: { projects: true, providers: false, memory: true },
  }));
  assert.deepEqual(preferences.readConfigSyncDraft(store), {
    ...connection, categories: { providers: false, memory: true },
  });
  preferences.writeConfigSyncDraft({ ...connection, categories: { projects: false, mcp: true } }, store);
  const saved = JSON.parse(store.getItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY));
  assert.deepEqual(saved.categories, { mcp: true });
  assert.equal(Object.hasOwn(saved.categories, "projects"), false);
});
