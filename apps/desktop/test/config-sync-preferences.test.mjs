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
const compiled = await transform(source, {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
const preferences = await import(
  `data:text/javascript,${encodeURIComponent(compiled.code)}`,
);

function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("config sync draft persists connection choices without secrets", () => {
  const store = fakeStorage();
  preferences.writeConfigSyncDraft(
    {
      endpoint: "http://127.0.0.1:49152/dav/",
      username: "alice",
      directory: "pi-desktop",
      deviceLabel: "MacBook",
      remoteMode: "strict",
      categories: { providers: true, credentials: false },
      saved: false,
    },
    store,
  );

  const raw = store.values.get(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY);
  assert.ok(raw);
  assert.doesNotMatch(raw, /password|secret/i);
  assert.deepEqual(preferences.readConfigSyncDraft(store), {
    endpoint: "http://127.0.0.1:49152/dav/",
    username: "alice",
    directory: "pi-desktop",
    deviceLabel: "MacBook",
    remoteMode: "strict",
    categories: { providers: true, credentials: false },
    saved: false,
  });
});

test("config sync draft ignores malformed or overlong local storage values", () => {
  const store = fakeStorage();
  store.setItem(
    preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY,
    JSON.stringify({
      endpoint: "x".repeat(2049),
      remoteMode: "unsafe",
      categories: { providers: "yes", mcp: true },
      saved: "no",
    }),
  );
  assert.deepEqual(preferences.readConfigSyncDraft(store), {
    categories: { mcp: true },
  });
});

test("config sync history cache expires without blocking the state cache", () => {
  const entries = [{
    revisionId: "revision-a",
    createdAt: "2026-09-25T00:00:00.000Z",
    parentRevisionIds: [],
    entityCount: 1,
    resourceCount: 1,
    current: true,
  }];
  preferences.cacheConfigSyncHistory(entries, 1000);
  assert.equal(preferences.hasFreshConfigSyncHistory(1000), true);
  assert.equal(preferences.hasFreshConfigSyncHistory(1000 + preferences.CONFIG_SYNC_HISTORY_CACHE_TTL_MS), false);
  assert.deepEqual(preferences.getCachedConfigSyncHistory(), entries);
});
