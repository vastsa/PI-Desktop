import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWindowsNativeSnap } from "../electron/main/window-native-snap.ts";
import { setWindowFullScreen } from "../electron/main/window-fullscreen.ts";

function fixture() {
  const window = new EventEmitter();
  let fullScreen = false;
  window.isDestroyed = () => false;
  window.getNativeWindowHandle = () => Buffer.from([0x78, 0x56, 0x34, 0x12]);
  window.isFullScreen = () => fullScreen;
  window.setFullScreen = (value) => {
    fullScreen = value;
    window.emit(value ? "enter-full-screen" : "leave-full-screen");
  };
  const calls = [];
  const warnings = [];
  const host = { async call(method, params, timeout) { calls.push({ method, params, timeout }); } };
  const logger = { app(...args) { warnings.push(args); } };
  return { window, host, calls, logger, warnings };
}

test("native snap is ready before startup continues and survives window transitions", async () => {
  const f = fixture();
  const controller = await installWindowsNativeSnap(f.window, () => f.host, f.logger);
  assert.deepEqual(f.calls[0], {
    method: "window.enableNativeSnap",
    params: { nativeHandle: "305419896", ownerPid: process.pid },
    timeout: 5_000,
  });
  for (const event of ["show", "focus", "blur", "maximize", "unmaximize", "restore"]) {
    const count = f.calls.length;
    f.window.emit(event);
    await controller.flush();
    assert.equal(f.calls.length, count + 1, event);
  }
  setWindowFullScreen(f.window, true, true);
  const count = f.calls.length;
  f.window.emit("show");
  await controller.flush();
  assert.equal(f.calls.length, count, "fullscreen does not gain resize/caption styles");
  setWindowFullScreen(f.window, false, true);
  await controller.flush();
  assert.equal(f.calls.length, count + 1, "leaving fullscreen restores native snap");
});

test("a failed optional style update is logged and can recover with a replacement Host", async () => {
  const f = fixture();
  let host = null;
  const controller = await installWindowsNativeSnap(f.window, () => host, f.logger);
  assert.equal(f.warnings.length, 1);
  host = f.host;
  f.window.emit("show");
  await controller.flush();
  assert.equal(f.calls.length, 1);
});

test("closing a window cancels queued native mutations and removes its subscriptions", async () => {
  const f = fixture();
  const controller = await installWindowsNativeSnap(f.window, () => f.host, f.logger);
  const count = f.calls.length;
  f.window.emit("restore");
  f.window.emit("closed");
  await controller.flush();
  assert.equal(f.calls.length, count);
  for (const event of ["show", "focus", "blur", "maximize", "unmaximize", "restore", "leave-full-screen"]) {
    assert.equal(f.window.listenerCount(event), 0);
  }
});

test("an invalid native handle never reaches Host", async () => {
  const f = fixture();
  f.window.getNativeWindowHandle = () => Buffer.alloc(8);
  await assert.rejects(installWindowsNativeSnap(f.window, () => f.host, f.logger), /invalid/);
  assert.equal(f.calls.length, 0);
});
