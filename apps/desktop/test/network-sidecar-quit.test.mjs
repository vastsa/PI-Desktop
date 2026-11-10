import assert from "node:assert/strict";
import test from "node:test";
import { activateSidecar } from "../electron/main/runtime/sidecar-startup.ts";

function fixture(configure = async () => {}) {
  const state = { host: { binaryPath: "fixture-host" }, sidecar: null, agentHostBridge: null };
  const network = { networkProxy: { mode: "direct" }, systemProxyRelayUrl: null, desktopDnsEnabled: false };
  const calls = [];
  let quitting = false;
  const candidate = {
    setHost() { calls.push("host"); },
    async call() { calls.push("configure"); await configure(); },
    async dispose() { calls.push("dispose"); },
  };
  return {
    state, candidate, calls,
    quit() { quitting = true; },
    activate: () => activateSidecar(state, candidate, "fixture-data", () => network, () => quitting),
  };
}

test("confirmed quit rejects a pending network activation and disposes its unpublished sidecar", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = fixture(() => { entered.resolve(); return release.promise; });
  const activation = f.activate();
  await entered.promise;
  assert.equal(f.state.sidecar, null);
  f.quit();
  release.resolve();
  await assert.rejects(activation, /shutting down|quit/i);
  assert.equal(f.state.sidecar, null);
  assert.deepEqual(f.calls, ["host", "configure", "dispose"]);
});

test("confirmed quit before activation disposes the candidate without configuring it", async () => {
  const f = fixture();
  f.quit();
  await assert.rejects(f.activate(), /shutting down|quit/i);
  assert.equal(f.state.sidecar, null);
  assert.deepEqual(f.calls, ["dispose"]);
});
