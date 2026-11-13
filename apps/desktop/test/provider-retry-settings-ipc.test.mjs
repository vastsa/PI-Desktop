import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

const source = readFileSync(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const module = { exports: {} };
new Function("require", "exports", "module", outputText)((name) => {
  if (name === "@pi-desktop/shared") return shared;
  if (name === "../network-proxy") return {
    currentSystemProxyRelayUrl: () => undefined,
    currentNetworkDns: () => ({ mode: "system" }),
  };
  throw new Error(`Unexpected dependency: ${name}`);
}, module.exports, module);

const fields = ["providerRetryMaxAttempts", "providerRetryInitialDelayMs", "providerRetryFixedDelayMs"];
function fixture(initial = {}) {
  const handlers = new Map();
  const writes = [];
  let stored = structuredClone(initial);
  let reads = 0;
  const host = { async call(method, patch) {
    if (method === "settings.get") { reads++; return structuredClone(stored); }
    assert.equal(method, "settings.set");
    writes.push(structuredClone(patch));
    stored = { ...stored, ...patch };
    return structuredClone(stored);
  } };
  const noop = () => {};
  module.exports.registerSettingsIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host, getSidecar: () => null, dataDir: "unused-isolated-fixture",
    // Other settings are delegated; retry validation must hold at this IPC boundary itself.
    normalizeSettings: (value) => value, validateSettingsWrite: (value) => value,
    testNetworkProxy: noop, applyNetworkProxyFromAppSettings: noop,
    currentNetworkProxy: noop, applyApplicationMenuSettings: noop,
    applyDeveloperMode: noop, applyPreventScreenSleep: noop,
    applyKeepAwakeWhileRunning: noop, applyUpdatePreference: noop,
    resolveEffectiveCommandShell: noop,
  });
  return { writes, reads: () => reads,
    get: () => handlers.get(shared.IPC.invoke.settingsGet)(),
    set: (patch) => handlers.get(shared.IPC.invoke.settingsSet)(patch) };
}

test("settings IPC rejects invalid retry writes before host access", async () => {
  const f = fixture();
  for (const field of fields) {
    for (const value of [-1, 1.5, "3", true, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      await assert.rejects(f.set({ [field]: value }), { errorCode: "INVALID_PARAMS", message: `${field} is invalid` });
    }
  }
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.writes, []);
});

test("settings IPC forwards valid retry patches and null resets without inventing omitted fields", async () => {
  const f = fixture({ theme: "dark" });
  for (const field of fields) {
    for (const value of [0, 3, Number.MAX_SAFE_INTEGER, null]) {
      await f.set({ [field]: value });
      assert.deepEqual(f.writes.at(-1), { [field]: value });
    }
  }
  await f.set({ theme: "light" });
  assert.deepEqual(f.writes.at(-1), { theme: "light" });
});

test("settings IPC normalizes unusable retry reads to absence, retaining zero", async () => {
  for (const field of fields) {
    for (const value of [null, undefined, -1, 1.5, "3", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const settings = await fixture({ [field]: value, theme: "light" }).get();
      assert.equal(Object.hasOwn(settings, field), false);
      assert.equal(settings.theme, "light");
    }
    for (const value of [0, 3, Number.MAX_SAFE_INTEGER]) {
      assert.equal((await fixture({ [field]: value }).get())[field], value);
    }
  }
});
