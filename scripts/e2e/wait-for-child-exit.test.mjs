import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForChildExitWithEscalation } from "./wait-for-child-exit.mjs";

function controlledTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    fireAfter(delay) {
      for (const [id, timer] of pending) {
        if (timer.delay === delay) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
    pending,
  };
}

test("a normally closing child exits without signals and clears both timers", async () => {
  const child = new EventEmitter();
  child.kill = () => assert.fail("a normally closing child must not be killed");
  const timers = controlledTimers();

  const result = waitForChildExitWithEscalation(child, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  child.emit("close", 0);

  assert.deepEqual(await result, { code: 0, killedBy: null });
  assert.equal(timers.pending.size, 0);
});

test("a child that ignores SIGTERM receives SIGKILL after the grace period", async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const timers = controlledTimers();

  const result = waitForChildExitWithEscalation(child, {
    termAfterMs: 60,
    killAfterMs: 65,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  timers.fireAfter(60);
  assert.deepEqual(signals, ["SIGTERM"]);
  timers.fireAfter(65);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);

  assert.deepEqual(await result, { code: null, killedBy: "SIGKILL" });
  assert.equal(timers.pending.size, 0);
});

test("a child that exits after SIGTERM is not escalated", async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const timers = controlledTimers();

  const result = waitForChildExitWithEscalation(child, {
    termAfterMs: 60,
    killAfterMs: 65,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  timers.fireAfter(60);
  child.emit("close", 0);

  assert.deepEqual(await result, { code: 0, killedBy: "SIGTERM" });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(timers.pending.size, 0);
});
