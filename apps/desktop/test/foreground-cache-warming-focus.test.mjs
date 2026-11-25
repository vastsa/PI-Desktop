import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register, registerHooks } from "node:module";
import test from "node:test";
import { IPC, JEV_API_KEY_SECRET_REF } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createForegroundCacheWarming } = await import("../electron/main/runtime/foreground-cache-warming.ts");

test("view selection controls idle warming while the active window allows waiting refreshes", () => {
  const window = new EventEmitter();
  const power = new EventEmitter();
  let focused = true;
  window.webContents = new EventEmitter();
  window.isDestroyed = () => false;
  window.isVisible = () => true;
  window.isMinimized = () => false;
  window.isFocused = () => focused;
  const calls = [];
  const controller = createForegroundCacheWarming({
    getMainWindow: () => window,
    getSidecar: () => ({ call: async (method, params) => calls.push([method, params]) }),
  });
  controller.observeWindow(window);
  controller.observePowerMonitor(power);
  const last = () => calls.at(-1);
  controller.setViewingSession("first");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: false, enabled: false }]);
  controller.applySettings({ foregroundCacheWarmingEnabled: true });
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: "first", waitAllowed: true, enabled: true }]);
  controller.setViewingSession("second");
  controller.noteTurnStarted("second");
  assert.deepEqual(last(), ["agent.invalidateCacheWarming", { sessionId: "second" }]);
  controller.notePluginChanged({ reason: "themes" });
  assert.deepEqual(last(), ["agent.invalidateCacheWarming", { sessionId: "second" }]);
  controller.noteTurnStarted("first");
  assert.deepEqual(last(), ["agent.invalidateCacheWarming", { sessionId: "first" }]);
  for (const reason of ["scope", "skill", "subagent", "loadDev", "crash", "hostRestart", "restore"]) {
    const previous = calls.length;
    controller.notePluginChanged({ reason });
    assert.equal(calls.length, previous + 1);
    assert.deepEqual(last(), ["agent.invalidateCacheWarming", { all: true }]);
  }
  focused = false;
  window.emit("blur");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: false, enabled: true }]);
  focused = true;
  window.emit("focus");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: "second", waitAllowed: true, enabled: true }]);
  power.emit("lock-screen");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: false, enabled: true }]);
  power.emit("unlock-screen");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: "second", waitAllowed: true, enabled: true }]);
  controller.setViewingSession(null);
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: true, enabled: true }]);
  window.webContents.emit("render-process-gone");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: false, enabled: true }]);
  window.emit("focus");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: false, enabled: true }]);
  window.webContents.emit("did-finish-load");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: true, enabled: true }]);
  controller.applySettings({ foregroundCacheWarmingEnabled: false });
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null, waitAllowed: false, enabled: false }]);
});


test("saved prompt settings invalidate before resolving without overriding a later opt-out", async () => {
  const proxyStub = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "../network-proxy" && context.parentURL?.endsWith("/ipc/settings-ipc.ts")) {
      return { url: "data:text/javascript,export const currentSystemProxyRelayUrl = () => null", shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const { registerSettingsIpc } = await import("../electron/main/ipc/settings-ipc.ts")
    .finally(() => proxyStub.deregister());
  const handlers = new Map();
  const effects = [];
  let settings = {};
  let releaseInvalidation;
  const invalidation = new Promise(resolve => { releaseInvalidation = resolve; });
  const host = { call: async (method, patch) => {
    if (method === "settings.get") return { ...settings };
    assert.equal(method, "settings.set");
    settings = { ...settings, ...patch };
    return { ok: true };
  } };
  registerSettingsIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host,
    getSidecar: () => ({ call: async (method, params) => {
      if (method !== "agent.invalidateCacheWarming") return;
      effects.push([method, params]);
      await invalidation;
    } }),
    validateSettingsWrite: value => value,
    applyForegroundCacheWarming: patch => effects.push(patch.foregroundCacheWarmingEnabled),
    applyNetworkProxyFromAppSettings: async () => {},
    currentNetworkProxy: () => null,
    applyApplicationMenuSettings() {},
    applyDeveloperMode() {},
  });
  const set = handlers.get(IPC.invoke.settingsSet);
  const enable = set({ foregroundCacheWarmingEnabled: true, computerUse: { enabled: true } });
  await set({ foregroundCacheWarmingEnabled: false });
  releaseInvalidation();
  await enable;
  await set({ computerUse: { enabled: true }, theme: "dark" });
  await set({ defaultCommandShell: "zsh", jevEnabled: true });
  assert.deepEqual(effects, [
    ["agent.invalidateCacheWarming", { all: true }], true, false,
    ["agent.invalidateCacheWarming", { all: true }],
  ]);
});

test("only committed classifier secret changes invalidate warming", async () => {
  const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
  const handlers = new Map();
  const effects = [];
  const host = { call: async (method, { secretRef, value }) => {
    if (value === "rejected") throw new Error("write failed");
    effects.push([method, secretRef]);
    return { ok: true };
  } };
  registerProviderIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host,
    invalidateCacheWarming: async () => { effects.push("invalidate"); },
  });
  const set = handlers.get(IPC.invoke.secretsSet);
  await set({ secretRef: "secret:fixture", value: "fixture-value" });
  await assert.rejects(set({ secretRef: JEV_API_KEY_SECRET_REF, value: "rejected" }), /write failed/);
  await set({ secretRef: JEV_API_KEY_SECRET_REF, value: "fixture-value" });
  await handlers.get(IPC.invoke.secretsHas)(JEV_API_KEY_SECRET_REF);
  await handlers.get(IPC.invoke.secretsDelete)(JEV_API_KEY_SECRET_REF);
  assert.deepEqual(effects, [
    ["secrets.set", "secret:fixture"],
    ["secrets.set", JEV_API_KEY_SECRET_REF], "invalidate",
    ["secrets.has", JEV_API_KEY_SECRET_REF],
    ["secrets.delete", JEV_API_KEY_SECRET_REF], "invalidate",
  ]);
});
