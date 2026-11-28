import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWindowStateSync } from "../electron/main/window-state-sync.ts";
import { readMainSource } from "./helpers/source-contracts.mjs";

const mainSource = await readMainSource();

function fixture() {
  const window = new EventEmitter();
  const timers = new Map();
  let timerId = 0;
  let maximized = true;
  const reports = [];
  const scheduler = {
    setTimeout(callback, delayMs) {
      assert.equal(delayMs, 300);
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  installWindowStateSync(
    window,
    () => reports.push(maximized),
    300,
    scheduler,
  );
  return {
    window,
    reports,
    timers,
    setMaximized: (value) => { maximized = value; },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    dispose() { window.emit("closed"); },
  };
}

test("fullscreen transitions report the settled native maximize state", () => {
  const f = fixture();
  for (const event of ["enter-full-screen", "leave-full-screen"]) {
    f.setMaximized(true);
    f.window.emit("maximize");
    f.window.emit(event);
    // AppKit may update the flag after the event without emitting unmaximize.
    f.setMaximized(false);
    assert.equal(f.reports.at(-1), true);
    f.runTimers();
    assert.equal(f.reports.at(-1), false);
  }
  f.dispose();
});

test("maximize and unmaximize events report native state immediately", () => {
  const f = fixture();
  f.setMaximized(false);
  f.window.emit("unmaximize");
  f.setMaximized(true);
  f.window.emit("maximize");
  assert.deepEqual(f.reports, [false, true]);
  f.dispose();
});

test("fullscreen state resync timers are replaced and disposed on window close", () => {
  const f = fixture();
  f.window.emit("enter-full-screen");
  f.window.emit("leave-full-screen");
  assert.equal(f.timers.size, 1);
  f.dispose();
  assert.equal(f.timers.size, 0);
  f.runTimers();
  assert.deepEqual(f.reports, []);
});

test("Main retains fullscreen broadcasts and installs maximize resync", () => {
  assert.match(mainSource, /window\.on\("enter-full-screen", sendFullScreen\)/);
  assert.match(mainSource, /window\.on\("leave-full-screen", \(\) => \{\s*sendFullScreen\(\)/);
  assert.match(mainSource, /installWindowStateSync\(window, sendMaximized, windowBoundsSettleMs\)/);
});
