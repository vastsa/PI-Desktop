import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createForegroundCacheWarming } = await import("../electron/main/runtime/foreground-cache-warming.ts");

test("only the selected, visible, focused conversation is sent to the sidecar", () => {
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
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null }]);
  controller.applySettings({ foregroundCacheWarmingEnabled: true });
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: "first" }]);
  controller.setViewingSession("second");
  controller.noteTurnStarted("second");
  assert.deepEqual(last(), ["agent.invalidateCacheWarming", { sessionId: "second" }]);
  focused = false;
  window.emit("blur");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null }]);
  focused = true;
  window.emit("focus");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: "second" }]);
  power.emit("lock-screen");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null }]);
  power.emit("unlock-screen");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: "second" }]);
  controller.setViewingSession(null);
  window.emit("focus");
  assert.deepEqual(last(), ["agent.setCacheWarmingSession", { sessionId: null }]);
});
