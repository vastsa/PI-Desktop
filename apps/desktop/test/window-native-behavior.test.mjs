import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installMaximizedWindowGuard, installTransparentWindowsMaximize, nativeWindowMinimumSize } from "../electron/main/window-native-behavior.ts";

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform}: a normal window fits a small display's native half tile`, () => {
    const minimum = nativeWindowMinimumSize({ width: 800, height: 560 }, { width: 1440, height: 900 }, platform);
    assert.ok(minimum.width <= 720 - (platform === "darwin" ? 16 : 0));
    assert.equal(minimum.height, 560);
    assert.deepEqual(nativeWindowMinimumSize({ width: 800, height: 560 }, { width: 1920, height: 1080 }, platform), { width: 800, height: 560 });
    assert.deepEqual(nativeWindowMinimumSize({ width: 800, height: 560 }, { width: 0, height: 0 }, platform), { width: 1, height: 1 });
  });
}

function fixture(platform, initiallyMaximized = false) {
  const window = new EventEmitter();
  let maximized = initiallyMaximized;
  let movable = true;
  window.isMaximized = () => maximized;
  window.isDestroyed = () => false;
  window.isMovable = () => movable;
  window.setMovable = (value) => { movable = value; };
  const dispose = installMaximizedWindowGuard(window, platform);
  const transition = (value) => { maximized = value; window.emit(value ? "maximize" : "unmaximize"); };
  const drag = (event) => {
    let prevented = false;
    window.emit(event, { preventDefault() { prevented = true; } });
    return prevented;
  };
  return { window, transition, drag, dispose, setNativeMaximized: (value) => { maximized = value; } };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: maximize protects edges; restore re-enables native gestures`, () => {
    const f = fixture(platform);
    assert.equal(f.drag("will-resize"), false);
    f.transition(true);
    assert.equal(f.drag("will-resize"), true);
    assert.equal(f.drag("will-move"), false, "native drag-to-restore remains OS-owned");
    f.transition(false);
    assert.equal(f.drag("will-resize"), false);
    assert.equal(f.drag("will-move"), false);
    assert.equal(f.window.isMovable(), true);
    f.window.emit("closed");
    for (const event of ["will-resize", "will-move", "maximize", "unmaximize"]) assert.equal(f.window.listenerCount(event), 0);
  });
}

test("macOS: an already maximized window protects edges without disabling native zoom", () => {
  const f = fixture("darwin", true);
  assert.equal(f.window.isMovable(), true);
  assert.equal(f.drag("will-resize"), true);
  f.dispose();
  assert.equal(f.window.isMovable(), true);
  assert.equal(f.drag("will-resize"), false);
});

test("Linux retains compositor-owned maximize and movement", () => {
  const f = fixture("linux", true);
  assert.equal(f.window.isMovable(), true);
  assert.equal(f.drag("will-move"), false);
  assert.equal(f.drag("will-resize"), false);
  f.dispose();
});


function transparentFixture() {
  const window = new EventEmitter();
  let destroyed = false;
  let maximized = false;
  let fullscreen = false;
  const hooks = new Map();
  let count = 0;
  window.isDestroyed = () => destroyed;
  window.isMaximized = () => maximized;
  window.isFullScreen = () => fullscreen;
  window.maximize = () => { count += 1; maximized = true; };
  window.hookWindowMessage = (message, callback) => hooks.set(message, callback);
  window.unhookWindowMessage = (message) => hooks.delete(message);
  const dispose = installTransparentWindowsMaximize(window);
  return { window, dispose, hooks, get count() { return count; },
    setFullscreen: (value) => { fullscreen = value; },
    close() { destroyed = true; window.emit("closed"); },
    command(command) { const buffer = Buffer.alloc(8); buffer.writeUInt32LE(command); hooks.get(0x112)?.(buffer); },
  };
}

test("transparent Windows caption/keyboard maximize reaches the public API after native dispatch", async () => {
  const f = transparentFixture();
  f.command(0xf031); // low four bits are reserved by WM_SYSCOMMAND.
  f.command(0xf030);
  assert.equal(f.count, 0);
  await new Promise(setImmediate);
  assert.equal(f.count, 1);
  f.command(0xf030);
  await new Promise(setImmediate);
  assert.equal(f.count, 1, "already maximized is not toggled back");
  f.dispose();
  assert.equal(f.hooks.size, 0);
});

test("transparent Windows leaves unrelated commands/fullscreen alone and cancels on close", async () => {
  const f = transparentFixture();
  f.command(0xf020); // minimize
  f.command(0xf120); // restore
  await new Promise(setImmediate);
  assert.equal(f.count, 0);
  f.setFullscreen(true);
  f.command(0xf030);
  await new Promise(setImmediate);
  assert.equal(f.count, 0);
  f.setFullscreen(false);
  f.command(0xf030);
  f.close();
  await new Promise(setImmediate);
  assert.equal(f.count, 0);
});


test("macOS zoom animation is not blocked by an early native maximize flag", () => {
  const f = fixture("darwin");
  f.setNativeMaximized(true); // native flag precedes the end-of-zoom event.
  assert.equal(f.drag("will-resize"), false);
  f.window.emit("maximize");
  assert.equal(f.drag("will-resize"), true);
  f.setNativeMaximized(false); // programmatic bounds change, without native zoom.
  f.window.emit("resize");
  assert.equal(f.drag("will-resize"), false);
  f.dispose();
});
