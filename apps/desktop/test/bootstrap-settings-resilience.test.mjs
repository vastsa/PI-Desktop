import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { settleBootstrapRequests } from "../src/lib/bootstrap-result.ts";

const [storeSource, settingsPageSource] = await Promise.all([
  readFile(new URL("../src/stores/app-store.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
]);

test("an unrelated bootstrap failure retains a later settings response", async () => {
  let resolveSettings;
  const settingsRequest = new Promise((resolve) => {
    resolveSettings = resolve;
  });
  const resultRequest = settleBootstrapRequests(
    settingsRequest,
    Promise.reject(new Error("notifications unavailable")),
  );

  const settings = { theme: "light", defaultMode: "agent" };
  resolveSettings(settings);

  const result = await resultRequest;
  assert.equal(result.ok, false);
  assert.deepEqual(result.settings, settings);
  assert.match(result.error.message, /notifications unavailable/);
});

test("successful bootstrap returns settings and the remaining snapshot", async () => {
  const settings = { theme: "dark", defaultMode: "agent" };
  const snapshot = { sessions: [], providers: [] };
  const result = await settleBootstrapRequests(
    Promise.resolve(settings),
    Promise.resolve(snapshot),
  );

  assert.deepEqual(result, { ok: true, settings, snapshot });
});

test("a direct settings failure remains available to the recovery UI", async () => {
  const settingsError = new Error("settings unavailable");
  const result = await settleBootstrapRequests(
    Promise.reject(settingsError),
    Promise.resolve({ sessions: [] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.settings, undefined);
  assert.equal(result.error, settingsError);
});

test("bootstrap recovery is wired to the store and Settings never stays blank", () => {
  assert.match(storeSource, /settleBootstrapRequests\(/);
  assert.match(
    storeSource,
    /\.\.\.\(recoveredSettings \? \{ settings: recoveredSettings \} : \{\}\)/,
  );
  assert.match(settingsPageSource, /const recoverSettings = useCallback/);
  assert.match(settingsPageSource, /className="settings-recovery"/);
  assert.match(settingsPageSource, /errors\.action\.retry/);
});
