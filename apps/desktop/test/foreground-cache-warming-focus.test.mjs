import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import test from "node:test";

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
  controller.notePluginChanged({ reason: "scope" });
  assert.deepEqual(last(), ["agent.invalidateCacheWarming", { all: true }]);
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
