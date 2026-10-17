import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { clampBoundsToWorkArea, clampMinimumSizeToWorkArea, windowBoundsEqual } from "../electron/main/work-panel-window.ts";
import { isWindowFullScreen } from "../electron/main/window-fullscreen.ts";
import { readMainModule } from "./helpers/source-contracts.mjs";

const source = await readMainModule("bootstrap/window.ts");
const events = source.slice(source.indexOf("  const sendFullScreen ="), source.indexOf("  const reconcileWorkPanelDisplay ="));

function fullscreenEvents() {
  const window = new EventEmitter();
  const sent = [];
  const deferred = [];
  let destroyed = false;
  let fullScreen = true;
  let maximized = false;
  let bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  window.webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    send: (event, payload) => sent.push([event, JSON.parse(JSON.stringify(payload))]),
  });
  Object.assign(window, {
    isDestroyed: () => destroyed,
    isFullScreen: () => fullScreen,
    isMaximized: () => maximized,
    isMinimized: () => false,
    getBounds: () => ({ ...bounds }),
    setMinimumSize: () => {},
    setBounds: (value) => { bounds = { ...value }; maximized = false; },
  });
  vm.runInNewContext(stripTypeScriptTypes(events), {
    window,
    windowState: {},
    process: { platform: "win32", env: {} },
    IPC: { event: { windowFullScreen: "fullscreen", windowMaximized: "maximized" } },
    isLiveWindow: () => !destroyed,
    isWindowFullScreen,
    setImmediate: (callback) => deferred.push(callback),
    scheduleWorkPanelReservation: () => {},
    windowMinWidth: 800,
    windowMinHeight: 560,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) },
    clampBoundsToWorkArea,
    clampMinimumSizeToWorkArea,
    windowBoundsEqual,
  });
  return {
    window,
    sent,
    publishState(full, max = false) { fullScreen = full; maximized = max; },
    destroy() { destroyed = true; },
    flush() { for (const callback of deferred.splice(0)) callback(); },
  };
}

test("enter fullscreen publishes full and maximize states after native state settles", () => {
  const fixture = fullscreenEvents();
  fixture.publishState(false, true);
  fixture.window.emit("enter-full-screen");
  assert.deepEqual(fixture.sent, []);
  fixture.publishState(true, false);
  fixture.flush();
  assert.deepEqual(fixture.sent, [["fullscreen", { fullScreen: true }], ["maximized", { maximized: false }]]);
});

test("native fullscreen exit preserves the actual maximized restore state", () => {
  const fixture = fullscreenEvents();
  fixture.window.emit("leave-full-screen");
  assert.deepEqual(fixture.sent, []);
  fixture.publishState(false, true);
  fixture.flush();
  assert.equal(fixture.window.isMaximized(), true);
  assert.deepEqual(fixture.sent, [["maximized", { maximized: true }], ["fullscreen", { fullScreen: false }]]);
});

test("normal native fullscreen exit clamps restored bounds to the current work area", () => {
  const fixture = fullscreenEvents();
  fixture.window.emit("leave-full-screen");
  fixture.publishState(false);
  fixture.flush();
  assert.deepEqual(fixture.window.getBounds(), { x: 0, y: 0, width: 1280, height: 720 });
});

test("fullscreen exit does not resize a window minimized during the transition", () => {
  const fixture = fullscreenEvents();
  fixture.window.emit("leave-full-screen");
  fixture.publishState(false);
  fixture.window.isMinimized = () => true;
  fixture.flush();
  assert.deepEqual(fixture.window.getBounds(), { x: 0, y: 0, width: 1920, height: 1080 });
});

for (const state of ["destroyed", "reentered"]) {
  test(`deferred fullscreen exit ignores ${state} windows`, () => {
    const fixture = fullscreenEvents();
    fixture.window.emit("leave-full-screen");
    if (state === "destroyed") fixture.destroy();
    fixture.flush();
    assert.deepEqual(fixture.sent, []);
    assert.deepEqual(fixture.window.getBounds(), { x: 0, y: 0, width: 1920, height: 1080 });
  });
}
