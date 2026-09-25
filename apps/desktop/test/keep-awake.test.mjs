import assert from "node:assert/strict";
import test from "node:test";
import { createPowerSaveBlockerController } from "../electron/main/keep-awake.ts";

test("keep awake follows the saved global setting and app lifecycle", () => {
  const starts = [];
  const stops = [];
  const blocker = {
    start(kind) { starts.push(kind); return starts.length; },
    stop(id) { stops.push(id); },
  };
  const controller = createPowerSaveBlockerController(blocker, "prevent-app-suspension");

  assert.deepEqual(starts, []);
  controller.setEnabled(true);
  assert.deepEqual(starts, ["prevent-app-suspension"]);
  controller.setEnabled(true);
  assert.equal(starts.length, 1);
  controller.setEnabled(false);
  assert.deepEqual(stops, [1]);
  controller.setEnabled(true);
  assert.equal(starts.length, 2);
  controller.dispose();
  assert.deepEqual(stops, [1, 2]);
  controller.setEnabled(true);
  assert.equal(starts.length, 2);
});

test("dispose releases the blocker only once", () => {
  const stopped = [];
  const controller = createPowerSaveBlockerController({
    start: () => 7,
    stop: (id) => stopped.push(id),
  }, "prevent-app-suspension");
  controller.setEnabled(true);
  controller.dispose();
  controller.dispose();
  assert.deepEqual(stopped, [7]);
});

test("screen and system blockers remain independent when both settings are enabled", () => {
  const starts = [];
  const stops = [];
  const blocker = {
    start: (kind) => { starts.push(kind); return starts.length; },
    stop: (id) => { stops.push(id); },
    isStarted: () => true,
  };
  const screen = createPowerSaveBlockerController(blocker, "prevent-display-sleep");
  const system = createPowerSaveBlockerController(blocker, "prevent-app-suspension");
  screen.setEnabled(true);
  system.setEnabled(true);
  assert.deepEqual(starts, ["prevent-display-sleep", "prevent-app-suspension"]);
  system.setEnabled(false);
  assert.deepEqual(stops, [2]);
  screen.dispose();
  assert.deepEqual(stops, [2, 1]);
});
