import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

const { IPC } = shared;
const { outputText } = ts.transpileModule(readFileSync(
  new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8",
), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: "settings-ipc.ts",
});
const relayUrl = `socks5://system-auto:${"a".repeat(64)}@127.0.0.1:43210`;
const secureDns = { mode: "doh", serverUrl: "https://1.1.1.1/dns-query", allowSystemFallback: false };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Exercise the real public IPC handler. Only process/native boundaries are faked;
// ordering, merged writes, failure propagation and identity guards are production code.
function fixture(initial = {}) {
  let stored = structuredClone(initial);
  let dns = { mode: "system" };
  let proxy = { mode: "system" };
  const handlers = new Map();
  const events = [];
  const applied = [];
  const configured = [];
  let hook = async () => {};
  const record = async (stage, payload) => {
    events.push(stage);
    await hook(stage, payload);
  };
  const makeHost = () => ({
    binaryPath: "fixture-host",
    async call(method, params) {
      await record(method, params);
      if (method === "settings.get") return structuredClone(stored);
      if (method === "settings.set") {
        stored = { ...stored, ...structuredClone(params) };
        // Mirror the real Host contract: a write is acknowledged, not echoed.
        return { ok: true };
      }
      if (method === "network.configureSystemProxyRelay") {
        configured.push(structuredClone(params));
        return {};
      }
      throw new Error(`Unexpected Host RPC: ${method}`);
    },
  });
  let host = makeHost();
  const makeSidecar = () => ({
    async call(method, params) {
      assert.equal(method, "sidecar.configure");
      await record(method, params);
      configured.push(structuredClone(params));
      return {};
    },
  });
  let sidecar = makeSidecar();
  const nativeBoundary = {
    currentNetworkDns: () => dns,
    currentSystemProxyRelayUrl: () => relayUrl,
    ensureSystemProxyRelay: async () => { await record("relay.ensure"); return relayUrl; },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((specifier) => {
    if (specifier === "@pi-desktop/shared") return shared;
    if (specifier === "../network-proxy") return nativeBoundary;
    throw new Error(`Unexpected module dependency: ${specifier}`);
  }, module.exports, module);
  module.exports.registerSettingsIpc({
    registrar: { handle: (channel, callback) => handlers.set(channel, callback) },
    getHost: () => host,
    getSidecar: () => sidecar,
    dataDir: "fixture-data",
    normalizeSettings: (value) => value,
    validateSettingsWrite: (value) => value,
    testNetworkProxy: async () => { throw new Error("No connectivity test is authorized"); },
    applyNetworkProxyFromAppSettings: async (settings) => {
      await record("network.apply", settings);
      applied.push(structuredClone(settings));
      dns = settings.networkDns ?? { mode: "system" };
      proxy = settings.networkProxy ?? { mode: "system" };
    },
    currentNetworkProxy: () => proxy,
    applyApplicationMenuSettings() {},
    applyDeveloperMode() {},
    applyPreventScreenSleep() {},
    applyKeepAwakeWhileRunning() {},
    applyUpdatePreference() {},
    resolveEffectiveCommandShell: async () => ({}),
  });
  return {
    events, applied, configured,
    read: () => handlers.get(IPC.invoke.settingsGet)(),
    write: (patch) => handlers.get(IPC.invoke.settingsSet)(patch),
    setHook: (value) => { hook = value; },
    replaceHost: () => { host = makeHost(); },
    replaceSidecar: () => { sidecar = makeSidecar(); },
  };
}

test("a partial settings save preserves secure DNS and proxy through Host and sidecar configuration", async () => {
  const networkProxy = { mode: "custom", url: "http://proxy.invalid:8080", bypass: "localhost" };
  const f = fixture({ networkDns: secureDns, networkProxy, theme: "light" });
  assert.deepEqual(await f.write({ theme: "dark" }), { ok: true });
  const persisted = { networkDns: secureDns, networkProxy, theme: "dark" };
  assert.deepEqual(await f.read(), persisted);
  assert.deepEqual(f.applied, [persisted]);
  assert.equal(f.configured.length, 2);
  assert.deepEqual(f.configured[0], { url: relayUrl, desktopDnsEnabled: true });
  assert.equal(f.configured[1].desktopDnsEnabled, true);
  assert.equal(f.configured[1].systemProxyRelayUrl, relayUrl);
  assert.deepEqual(f.configured[1].networkProxy, networkProxy);
});

test("saving an unrelated setting after enabling secure DNS keeps it applied", async () => {
  const f = fixture({ theme: "light" });
  await f.write({ networkDns: secureDns });
  await f.write({ theme: "dark" });
  assert.deepEqual(f.applied.map((settings) => settings.networkDns), [secureDns, secureDns]);
  assert.ok(f.configured.length > 0);
  assert.ok(f.configured.every((value) => value.desktopDnsEnabled === true));
  assert.equal(f.configured.at(-1).systemProxyRelayUrl, relayUrl);
});

test("concurrent saves apply in order and use authoritative merged settings", async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  let first = true;
  f.setHook(async (stage) => {
    if (stage === "network.apply" && first) {
      first = false;
      started.resolve();
      await release.promise;
    }
  });
  const enabling = f.write({ networkDns: secureDns });
  await started.promise;
  const appearance = f.write({ theme: "dark" });
  assert.equal(f.events.filter((stage) => stage === "settings.set").length, 1);
  release.resolve();
  await Promise.all([enabling, appearance]);
  assert.deepEqual(f.applied, [
    { networkDns: secureDns },
    { networkDns: secureDns, theme: "dark" },
  ]);
  assert.deepEqual(await f.read(), f.applied[1]);
  assert(f.configured.every((value) => value.desktopDnsEnabled === true));
});

test("a native apply error is visible and a later disabling write can recover", async () => {
  const f = fixture();
  f.setHook(async (stage) => {
    if (stage === "network.apply") throw new Error("native resolver unavailable");
  });
  await assert.rejects(f.write({ networkDns: secureDns }), /native resolver unavailable/);
  assert.deepEqual(f.configured, []);
  // Persistence precedes runtime application; the next write must remain usable.
  assert.deepEqual((await f.read()).networkDns, secureDns);
  f.setHook(async () => {});
  await f.write({ networkDns: { mode: "system" } });
  assert.equal(f.configured.at(-1).desktopDnsEnabled, false);
});

test("secure DNS never reports success when the provider sidecar rejects configuration", async () => {
  const f = fixture();
  f.setHook(async (stage) => {
    if (stage === "sidecar.configure") throw new Error("sidecar unavailable");
  });
  await assert.rejects(f.write({ networkDns: secureDns }), /sidecar unavailable/);
  f.setHook(async () => {});
  await f.write({ networkDns: secureDns });
  assert.equal(f.configured.at(-1).desktopDnsEnabled, true);
});

test("a required relay failure does not configure a fallback provider transport", async () => {
  const f = fixture();
  f.setHook(async (stage) => {
    if (stage === "relay.ensure") throw new Error("relay unavailable");
  });
  await assert.rejects(f.write({ networkDns: secureDns }), /relay unavailable/);
  assert.deepEqual(f.configured, []);
});

for (const stage of [
  "settings.get", "settings.set", "network.apply", "relay.ensure",
  "network.configureSystemProxyRelay", "sidecar.configure",
]) {
  test(`Host replacement during ${stage} rejects stale settings application`, async () => {
    const f = fixture();
    f.setHook(async (event) => { if (event === stage) f.replaceHost(); });
    await assert.rejects(f.write({ networkDns: secureDns }), /host changed during network setup/);
    assert.equal(f.events.at(-1), stage, "no later process boundary receives the stale write");
    f.setHook(async () => {});
    await f.write({ networkDns: { mode: "system" } });
    assert.equal(f.configured.at(-1).desktopDnsEnabled, false, "the new Host can recover");
  });
}

test("sidecar replacement while applying settings does not report stale success", async () => {
  const f = fixture();
  f.setHook(async (stage) => { if (stage === "sidecar.configure") f.replaceSidecar(); });
  await assert.rejects(f.write({ networkDns: secureDns }), /sidecar changed during network setup/);
});
