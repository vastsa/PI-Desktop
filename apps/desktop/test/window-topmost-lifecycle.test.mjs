import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import {
  clampMinimumSizeToWorkArea,
  emptyWorkPanelReservationState,
  windowBoundsEqual,
} from "../electron/main/work-panel-window.ts";
import { readMainModule } from "./helpers/source-contracts.mjs";

const source = await readMainModule("bootstrap/window.ts");
// Execute the production recovery, event wiring and watchdog without booting Electron.
const recovery = source.slice(
  source.indexOf("  const CODEX_BOUNDS ="),
  source.indexOf('  window.on("resize", observeNativeWorkPanelResize)'),
);
const watchdogStart = source.indexOf("  const boundsWatchdog:");
const watchdog = source.slice(watchdogStart, source.indexOf('  window.on("closed",', watchdogStart));

function createRecoveryWindow(platform, { tiny = false, visible = true, minimized = false } = {}) {
  let now = 10000;
  let bounds = { x: 80, y: 70, width: tiny ? 300 : 1000, height: 700 };
  let topmost = false;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const window = Object.assign(new EventEmitter(), {
    isMaximized: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    getBounds: () => ({ ...bounds }),
    restore: () => { minimized = false; calls.push("restore"); },
    setMinimumSize: () => calls.push("minimum"),
    setAlwaysOnTop: (value) => { topmost = value; calls.push(value ? "pin" : "unpin"); },
    show: () => { visible = true; calls.push("show"); },
    hide: () => { visible = false; calls.push("hide"); },
    focus: () => calls.push("focus"),
    moveTop: () => calls.push("raise"),
    setBounds: (value) => { bounds = { ...value }; calls.push("bounds"); },
    setSize: (width, height) => { bounds = { ...bounds, width, height }; },
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
  });
  const schedule = (callback, delay, repeat = false) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, delay, repeat });
    return id;
  };
  vm.runInNewContext(stripTypeScriptTypes(`${recovery}\n${watchdog}`), {
    window,
    windowState: {},
    windowMinWidth: 800,
    windowMinHeight: 560,
    windowBoundsSettleMs: 300,
    isLiveWindow: () => true,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    clampMinimumSizeToWorkArea,
    emptyWorkPanelReservationState,
    windowBoundsEqual,
    applyWorkPanelReservation: () => {},
    existsSync: () => false,
    process: { platform },
    Date: { now: () => now },
    console: { log: () => {} },
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: (id) => timers.delete(id),
  });
  return {
    window,
    calls,
    get topmost() { return topmost; },
    get timerCount() { return timers.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.delay;
        else timers.delete(id);
        timer.callback();
      }
      now = end;
    },
  };
}

for (const platform of ["win32", "linux", "darwin"]) {
  for (const event of ["show", "focus", "restore"]) {
    test(`${platform}: ${event} recovers tiny geometry with platform-owned pin cleanup`, () => {
      const app = createRecoveryWindow(platform, { tiny: true });
      app.window.emit(event);
      assert.deepEqual(app.window.getBounds(), { x: 40, y: 30, width: 1200, height: 800 });
      if (platform === "darwin") {
        assert.equal(app.topmost, true);
        app.advance(3999);
        assert.equal(app.topmost, true, "keep the recovery pin until its deadline");
        app.advance(501);
        assert.equal(app.topmost, false, "the existing watchdog must release the expired pin");
      } else {
        app.advance(10000);
      }
      app.window.emit("focus");
      assert.equal(app.topmost, false, "normal focus must not leave the window pinned");
      assert.equal(app.calls.includes("pin"), platform === "darwin");
      if (platform !== "darwin") assert.equal(app.timerCount, 0, "no layer watchdog off macOS");
    });
  }

  test(`${platform}: normal focus does not raise or resize the window`, () => {
    const app = createRecoveryWindow(platform);
    app.window.emit("focus");
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.window.getBounds(), { x: 80, y: 70, width: 1000, height: 700 });
  });

  for (const state of [{ visible: false }, { minimized: true }]) {
    test(`${platform}: hidden/minimized tiny windows preserve user state ${JSON.stringify(state)}`, () => {
      const app = createRecoveryWindow(platform, { tiny: true, ...state });
      for (const event of ["show", "focus", "restore"]) app.window.emit(event);
      app.advance(10000);
      assert.deepEqual(app.calls, []);
      assert.equal(app.topmost, false);
      assert.deepEqual(app.window.getBounds(), { x: 80, y: 70, width: 300, height: 700 });
    });
  }
}
