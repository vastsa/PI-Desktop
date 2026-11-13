import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import { RuntimeSupervisor } from "@pi-desktop/host-runtime";
import { syncPluginDisplayLocale } from "../electron/main/plugin-display-locale.ts";

// Execute the production lifecycle. Only OS/process/native-DNS boundaries are
// faked; locale synchronization and restart supervision use their real code.
function lifecycleFixture({
  settings = { networkDns: { mode: "doh" } },
  relayUrl = "socks5://fixture:token@127.0.0.1:12345",
  onStage = async () => {},
} = {}) {
  const order = [];
  const configurations = [];
  const state = { host: null, sidecar: null, agentHostBridge: null };
  const stage = async (name) => {
    order.push(name);
    await onStage(name, state);
  };
  const host = {
    async call(method, params) {
      await stage(method);
      if (method === "settings.get") return settings;
      if (method === "network.configureSystemProxyRelay") configurations.push(params);
      if (method === "workspace.get") return { workspace: null };
      if (method === "plugins.list") return { plugins: [] };
      return {};
    },
  };
  const imports = {
    "node:fs": { mkdirSync() {} },
    "node:path": path,
    "@pi-desktop/shared": shared,
    "@pi-desktop/host-runtime": { RuntimeSupervisor },
    "../plugin-display-locale": { syncPluginDisplayLocale },
    "../linux-glibc": {
      isGlibcUnsupportedError: () => false,
      GLIBC_UNSUPPORTED_STATUS: "unsupported glibc",
    },
    "../host-boot-diagnostics": {
      DB_SCHEMA_TOO_NEW_STATUS: "schema too new",
      detectRuntimeArch: () => ({ mismatch: false }),
      schemaTooNewOf: () => null,
    },
    "../network-proxy": {
      currentNetworkDns: () => settings.networkDns ?? { mode: "system" },
      currentSystemProxyRelayUrl: () => relayUrl,
    },
  };
  const source = readFileSync(new URL("../electron/main/runtime/lifecycle.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked boundary: ${specifier}`);
    return imports[specifier];
  }, module.exports, module);
  const lifecycle = module.exports.createRuntimeLifecycle({
    runtimeState: state,
    dataDir: "fixture-data",
    logger: { app() {} },
    sendToRenderer() {},
    startHost: async () => { state.host = host; await stage("host:start"); },
    startSidecar: async () => { await stage("sidecar:start"); },
    drainApprovedPlanExecutions: async () => {},
    applyNetworkProxyFromAppSettings: async (stored) => {
      assert.equal(stored, settings, "the complete stored settings reach the native boundary");
      await stage("network:apply");
    },
    plugins: { setServices() {} },
    setCurrentWorkspacePath() {},
    rememberPluginScopes() {},
    refreshUserMcp: async () => {},
    isQuitting: () => false,
    getDisplayLocale: () => "en",
  });
  return { lifecycle, order, configurations, state };
}

test("boot restores native DNS and the Host relay before admitting a sidecar", async () => {
  const f = lifecycleFixture();
  await f.lifecycle.bootBackends();
  assert.ok(f.order.indexOf("settings.get") < f.order.indexOf("network:apply"));
  assert.ok(f.order.indexOf("network:apply") < f.order.indexOf("network.configureSystemProxyRelay"));
  assert.ok(f.order.indexOf("network.configureSystemProxyRelay") < f.order.indexOf("sidecar:start"));
  assert.deepEqual(f.configurations, [{
    url: "socks5://fixture:token@127.0.0.1:12345", desktopDnsEnabled: true,
  }]);
});

for (const failureStage of ["settings.get", "network:apply", "network.configureSystemProxyRelay"]) {
  test(`boot never admits a sidecar after ${failureStage} fails`, async () => {
    const failure = new Error(`fixture failure: ${failureStage}`);
    const f = lifecycleFixture({ onStage: async (stage) => {
      if (stage === failureStage) throw failure;
    } });
    await assert.rejects(f.lifecycle.bootBackends(), (error) => error === failure);
    assert.ok(!f.order.includes("sidecar:start"));
  });
  test(`boot rejects a Host replacement during ${failureStage}`, async () => {
    const replacement = { call: () => assert.fail("a stale boot cannot configure the replacement Host") };
    const f = lifecycleFixture({ onStage: async (stage, state) => {
      if (stage === failureStage) state.host = replacement;
    } });
    await assert.rejects(f.lifecycle.bootBackends(), /host changed during network setup/);
    assert.equal(f.state.host, replacement);
    assert.ok(!f.order.includes("sidecar:start"));
  });
}

test("secure-DNS boot fails closed without a relay; disabled legacy boot remains valid", async () => {
  const secure = lifecycleFixture({ relayUrl: null });
  await assert.rejects(secure.lifecycle.bootBackends(), /requires an authenticated proxy relay/);
  assert.ok(!secure.order.includes("sidecar:start"));
  const disabled = lifecycleFixture({ settings: {}, relayUrl: null });
  await disabled.lifecycle.bootBackends();
  assert.ok(disabled.order.includes("sidecar:start"));
  assert.deepEqual(disabled.configurations, []);
});

test("the later UI bootstrap cannot replay a stale network settings snapshot", () => {
  const source = readFileSync(new URL("../electron/main/bootstrap/startup.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /applyNetworkProxyFromAppSettings/,
    "network restoration belongs to bootBackends, before sidecar admission");
});

function sidecarFixture(configure = async () => {}) {
  const configurations = [];
  const disposals = [];
  const hosts = [];
  const state = { host: { binaryPath: "fixture-host" }, sidecar: null, agentHostBridge: null };
  let network = {
    networkProxy: { mode: "direct" }, systemProxyRelayUrl: null, desktopDnsEnabled: false,
  };
  const sidecar = {
    setHost(host) { hosts.push(host); },
    async call(method, params) {
      assert.equal(method, "sidecar.configure");
      configurations.push(params);
      await configure(params, configurations.length);
      return { ok: true };
    },
    async dispose() { disposals.push(sidecar); },
  };
  return {
    state, sidecar, hosts, configurations, disposals,
    setNetwork(next) { network = next; },
    activate: async () => {
      const { activateSidecar } = await import("../electron/main/runtime/sidecar-startup.ts");
      return activateSidecar(state, sidecar, "fixture-data", () => network);
    },
  };
}

test("a sidecar becomes visible only after its network configuration succeeds", async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const f = sidecarFixture(() => { entered.resolve(); return gate.promise; });
  const operation = f.activate();
  await entered.promise;
  const duringConfiguration = f.state.sidecar;
  gate.resolve();
  await operation;
  assert.equal(duringConfiguration, null);
  assert.equal(f.state.sidecar, f.sidecar);
  assert.deepEqual(f.hosts, [f.state.host]);
  assert.deepEqual(f.configurations, [{
    hostBinary: "fixture-host", dataDir: "fixture-data", networkProxy: { mode: "direct" },
    systemProxyRelayUrl: null, desktopDnsEnabled: false,
  }]);
  assert.deepEqual(f.disposals, []);
});

test("a rejected sidecar configuration disposes the candidate without publishing it", async () => {
  const failure = new Error("secure DNS setup refused");
  const f = sidecarFixture(async () => { throw failure; });
  await assert.rejects(f.activate(), (error) => error === failure);
  assert.equal(f.state.sidecar, null);
  assert.deepEqual(f.disposals, [f.sidecar]);
});

for (const kind of ["host", "sidecar"]) {
  test(`a ${kind} replacement during configuration is not overwritten by the candidate`, async () => {
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const f = sidecarFixture(() => { entered.resolve(); return gate.promise; });
    const operation = f.activate();
    await entered.promise;
    const replacement = { replacement: kind };
    f.state[kind] = replacement;
    gate.resolve();
    await assert.rejects(operation, new RegExp(`${kind} changed during network setup`));
    assert.equal(f.state[kind], replacement);
    assert.deepEqual(f.disposals, [f.sidecar]);
  });
}

test("sidecar activation catches up with network settings changed during configuration", async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const f = sidecarFixture((_params, count) => {
    if (count !== 1) return Promise.resolve();
    entered.resolve();
    return gate.promise;
  });
  const operation = f.activate();
  await entered.promise;
  const latest = {
    networkProxy: { mode: "system" },
    systemProxyRelayUrl: "socks5://fixture:token@127.0.0.1:12345",
    desktopDnsEnabled: true,
  };
  f.setNetwork(latest);
  gate.resolve();
  await operation;
  assert.equal(f.configurations.length, 2);
  assert.deepEqual(f.configurations.at(-1), { hostBinary: "fixture-host", dataDir: "fixture-data", ...latest });
  assert.equal(f.state.sidecar, f.sidecar);
  assert.deepEqual(f.disposals, []);
});

test("a sidecar cannot become available without its Host", async () => {
  const f = sidecarFixture();
  f.state.host = null;
  await assert.rejects(f.activate(), /host unavailable during network setup/);
  assert.deepEqual(f.configurations, []);
  assert.deepEqual(f.disposals, [f.sidecar]);
  assert.equal(f.state.sidecar, null);
});
