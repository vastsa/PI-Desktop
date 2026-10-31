import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * Background-tasks bar visibility. The registry in host-core keeps finished
 * tasks as history; the bar must not turn that history into permanent rows
 * above the composer. These tests pin the renderer-side rule with a controlled
 * clock, so "did this row disappear yet" is decided by explicit timestamps
 * instead of wall time.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  ENDED_VISIBLE_MS,
  EMPTY_VISIBILITY,
  canDismiss,
  dismissTask,
  nextExpiryAt,
  observeTasks,
  selectVisibleTasks,
} = await import("../src/features/chat/background-tasks/bar-visibility.ts");

const task = (id, state, exitCode) => ({
  id,
  sessionId: "session-1",
  command: `cmd ${id}`,
  commandShellId: "bash",
  state,
  elapsedMs: 1_000,
  exitCode,
});

const ids = (tasks) => tasks.map((entry) => entry.id);

test("a task that is already finished when first observed never gets a row", () => {
  const finished = [task("xcodebuild", "exited", 0), task("go-vet", "exited", 0)];
  const state = observeTasks(EMPTY_VISIBILITY, finished, 1_000);

  assert.deepEqual(selectVisibleTasks(state, finished, 1_000), []);
  assert.equal(nextExpiryAt(state, finished, 1_000), null);
});

test("a task observed running shows, keeps a grace window after exit, then leaves", () => {
  const running = [task("a", "running")];
  let state = observeTasks(EMPTY_VISIBILITY, running, 1_000);
  assert.deepEqual(ids(selectVisibleTasks(state, running, 1_000)), ["a"]);

  const ended = [task("a", "exited", 0)];
  state = observeTasks(state, ended, 5_000);
  assert.deepEqual(ids(selectVisibleTasks(state, ended, 5_000)), ["a"]);
  assert.deepEqual(ids(selectVisibleTasks(state, ended, 5_000 + ENDED_VISIBLE_MS - 1)), ["a"]);
  assert.deepEqual(selectVisibleTasks(state, ended, 5_000 + ENDED_VISIBLE_MS), []);
});

test("a row the user removed stays removed across later snapshots", () => {
  let state = observeTasks(EMPTY_VISIBILITY, [task("a", "running")], 0);
  const ended = [task("a", "exited", 0)];
  state = observeTasks(state, ended, 100);
  assert.equal(selectVisibleTasks(state, ended, 100).length, 1);

  state = dismissTask(state, ended[0]);
  assert.deepEqual(selectVisibleTasks(state, ended, 100), []);
  state = observeTasks(state, ended, 200);
  assert.deepEqual(selectVisibleTasks(state, ended, 200), []);
});

test("the row whose output is open is not pulled away by the grace window", () => {
  let state = observeTasks(EMPTY_VISIBILITY, [task("a", "running")], 0);
  const ended = [task("a", "exited", 0)];
  state = observeTasks(state, ended, 100);
  const muchLater = 100 + ENDED_VISIBLE_MS * 3;

  assert.deepEqual(ids(selectVisibleTasks(state, ended, muchLater, "a")), ["a"]);
  assert.equal(nextExpiryAt(state, ended, muchLater, "a"), null);
});

test("running tasks never expire, and a running task cannot be removed", () => {
  const running = [task("server", "running")];
  const state = observeTasks(EMPTY_VISIBILITY, running, 0);
  assert.equal(nextExpiryAt(state, running, 10 * ENDED_VISIBLE_MS), null);

  // Removal is a view action but must not make a live task unreachable: the
  // state layer refuses it, so the row stays.
  const afterRefusal = dismissTask(state, running[0]);
  assert.equal(afterRefusal, state, "a refused removal must not change state");
  assert.deepEqual(ids(selectVisibleTasks(afterRefusal, running, 0)), ["server"]);
});

test("removal is refused while a stopped task is still settling", () => {
  // A task that has been signalled keeps `running` until the supervisor records
  // the terminal state, so it must stay out of removal during that window.
  const settling = [task("server", "running")];
  const state = observeTasks(EMPTY_VISIBILITY, settling, 0);
  assert.equal(canDismiss(state, settling[0]), false);
  assert.equal(dismissTask(state, settling[0]), state);
});

test("expiry reports the earliest deadline among the rows still visible", () => {
  let state = observeTasks(EMPTY_VISIBILITY, [task("a", "running"), task("b", "running")], 0);
  state = observeTasks(state, [task("a", "exited", 0), task("b", "running")], 1_000);
  const both = [task("a", "exited", 0), task("b", "exited", 0)];
  state = observeTasks(state, both, 2_000);

  assert.equal(nextExpiryAt(state, both, 2_000), 1_000 + ENDED_VISIBLE_MS);
  assert.deepEqual(ids(selectVisibleTasks(state, both, 1_000 + ENDED_VISIBLE_MS)), ["b"]);
  assert.equal(nextExpiryAt(state, both, 1_000 + ENDED_VISIBLE_MS), 2_000 + ENDED_VISIBLE_MS);
});

test("bookkeeping is pruned when the registry drops a task, so it cannot grow", () => {
  let state = observeTasks(EMPTY_VISIBILITY, [task("a", "running"), task("b", "running")], 0);
  // A terminal row may be removed; that is what puts an id into `dismissed`.
  state = dismissTask(state, task("a", "exited", 0));
  assert.deepEqual([...state.seenRunning].sort(), ["a", "b"]);
  assert.deepEqual([...state.dismissed], ["a"]);

  state = observeTasks(state, [task("b", "running")], 10);
  assert.deepEqual([...state.seenRunning], ["b"]);
  assert.deepEqual([...state.dismissed], []);
  assert.equal(state.endedAt.size, 0);
});

test("an unchanged snapshot keeps the previous state object", () => {
  const running = [task("a", "running")];
  const state = observeTasks(EMPTY_VISIBILITY, running, 0);
  assert.equal(observeTasks(state, running, 500), state);
});
