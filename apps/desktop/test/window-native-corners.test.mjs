import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyWindowCornerRadius,
  DEFAULT_WINDOW_CORNER_RADIUS,
  installWindows11CornerController,
  normalizeWindowCornerRadius,
  usesWindows11NativeCorners,
} from "../electron/main/window-native-corners.ts";

function makeWindow() {
  const window = new EventEmitter();
  let maximized = false;
  let fullScreen = false;
  let destroyed = false;
  window.getNativeWindowHandle = () => Buffer.from([0x78, 0x56, 0x34, 0x12]);
  window.isMaximized = () => maximized;
  window.isFullScreen = () => fullScreen;
  window.isDestroyed = () => destroyed;
  return {
    window,
    setMaximized(value) { maximized = value; },
    setFullScreen(value) { fullScreen = value; },
    close() {
      destroyed = true;
      window.emit("closed");
    },
  };
}

function makeHost(onCall = async () => undefined) {
  const calls = [];
  return {
    calls,
    async call(method, params, timeoutMs) {
      const call = { method, params, timeoutMs };
      calls.push(call);
      return onCall(call);
    },
  };
}

function makeScreen() {
  return new EventEmitter();
}

const logger = { app() {} };

test("default radius matches the global token and requests retain the SDK range", () => {
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const match = tokens.match(/^\s*--radius-md:\s*(\d+(?:\.\d+)?)px;/m);
  assert.ok(match);
  assert.equal(DEFAULT_WINDOW_CORNER_RADIUS, Number(match[1]));
  assert.deepEqual([-1, 0, 4.4, 12, 24, 100].map(normalizeWindowCornerRadius), [0, 0, 4, 12, 24, 24]);
});

test("Windows 11 detection uses the native build threshold", () => {
  assert.equal(usesWindows11NativeCorners("win32", "10.0.21999"), false);
  assert.equal(usesWindows11NativeCorners("win32", "10.0.22000"), true);
  assert.equal(usesWindows11NativeCorners("win32", "10.0.26100"), true);
  assert.equal(usesWindows11NativeCorners("darwin", "10.0.26100"), false);
  assert.equal(usesWindows11NativeCorners("win32", "unknown"), false);
});

test("DWM preference follows theme radius, window state, and display updates", async () => {
  const fixture = makeWindow();
  const host = makeHost();
  const screen = makeScreen();
  const controller = await installWindows11CornerController(
    fixture.window,
    12,
    () => host,
    screen,
    logger,
  );

  assert.deepEqual(host.calls[0], {
    method: "window.setNativeCornerPreference",
    params: {
      nativeHandle: "305419896",
      ownerPid: process.pid,
      preference: "round",
    },
    timeoutMs: 5_000,
  });

  fixture.setMaximized(true);
  fixture.window.emit("maximize");
  await controller.flush();
  assert.equal(host.calls.at(-1).params.preference, "square");

  fixture.setMaximized(false);
  fixture.window.emit("unmaximize");
  await controller.flush();
  assert.equal(host.calls.at(-1).params.preference, "round");

  fixture.setFullScreen(true);
  fixture.window.emit("enter-full-screen");
  await new Promise(setImmediate);
  await controller.flush();
  assert.equal(host.calls.at(-1).params.preference, "square");

  fixture.setFullScreen(false);
  fixture.window.emit("leave-full-screen");
  await new Promise(setImmediate);
  await controller.flush();
  assert.equal(host.calls.at(-1).params.preference, "round");

  assert.equal(await applyWindowCornerRadius(fixture.window, 0), 0);
  assert.equal(host.calls.at(-1).params.preference, "square");
  assert.equal(await applyWindowCornerRadius(fixture.window, 24), 24);
  assert.equal(host.calls.at(-1).params.preference, "round");

  const callCount = host.calls.length;
  screen.emit("display-metrics-changed", {}, { scaleFactor: 1.75 }, ["scaleFactor"]);
  await controller.flush();
  assert.equal(host.calls.length, callCount + 1);
  assert.equal(host.calls.at(-1).params.preference, "round");

  fixture.close();
  assert.equal(fixture.window.listenerCount("maximize"), 0);
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(await applyWindowCornerRadius(fixture.window, 8), null);
});

for (const entering of [true, false]) {
  test(`fullscreen corner updates wait for the published native state: entering=${entering}`, async () => {
    const fixture = makeWindow();
    fixture.setFullScreen(!entering);
    const host = makeHost();
    const controller = await installWindows11CornerController(fixture.window, 12, () => host, makeScreen(), logger);
    fixture.window.emit(entering ? "enter-full-screen" : "leave-full-screen");
    fixture.setFullScreen(entering);
    await new Promise(setImmediate);
    await controller.flush();
    assert.equal(host.calls.at(-1).params.preference, entering ? "square" : "round");
    fixture.close();
  });
}

for (const closed of [true, false]) {
  test(`deferred fullscreen corner updates skip unavailable windows: closed=${closed}`, async () => {
    const fixture = makeWindow();
    const host = makeHost();
    const controller = await installWindows11CornerController(fixture.window, 12, () => host, makeScreen(), logger);
    const initialCallCount = host.calls.length;
    fixture.window.emit("enter-full-screen");
    fixture.setFullScreen(true);
    if (closed) fixture.close();
    else fixture.window.isDestroyed = () => true;
    await new Promise(setImmediate);
    await controller.flush();
    assert.equal(host.calls.length, initialCallCount);
    if (closed) {
      assert.equal(fixture.window.listenerCount("enter-full-screen"), 0);
      assert.equal(fixture.window.listenerCount("leave-full-screen"), 0);
    }
  });
}

test("overlapping theme requests leave DWM with the newest preference", async () => {
  let beginSlowCall;
  let releaseSlowCall;
  const slowCallStarted = new Promise((resolve) => { beginSlowCall = resolve; });
  const slowCall = new Promise((resolve) => { releaseSlowCall = resolve; });
  let holdNext = false;
  const host = makeHost(async ({ params }) => {
    if (holdNext) {
      holdNext = false;
      beginSlowCall();
      await slowCall;
    }
    return { rounded: params.preference === "round" };
  });
  const fixture = makeWindow();
  const controller = await installWindows11CornerController(
    fixture.window,
    12,
    () => host,
    makeScreen(),
    logger,
  );

  holdNext = true;
  const first = controller.setRadius(24);
  await slowCallStarted;
  const second = controller.setRadius(0);
  releaseSlowCall();
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.deepEqual(
    host.calls.slice(-2).map((call) => call.params.preference),
    ["round", "square"],
  );
  assert.equal(host.calls.at(-1).params.preference, "square");
});
