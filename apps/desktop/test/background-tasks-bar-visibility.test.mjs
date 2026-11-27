import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * Background-tasks bar visibility. The registry in host-core keeps finished
 * tasks as history; the bar answers only to live work — a running task, or a
 * continuation decision still pending — plus the single row whose output the
 * user is reading, so an open log cannot vanish underneath it (#2632).
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { selectVisibleTasks } = await import("../src/features/chat/background-tasks/bar-visibility.ts");

const task = (id, state, extra = {}) => ({
  id,
  sessionId: "session-1",
  command: `cmd ${id}`,
  commandShellId: "bash",
  state,
  elapsedMs: 1_000,
  ...extra,
});

const ids = (tasks) => tasks.map((entry) => entry.id);

test("a task that is already finished when first listed never gets a row", () => {
  const finished = [task("xcodebuild", "exited", { exitCode: 0 }), task("go-vet", "failed", { exitCode: 1 })];
  assert.deepEqual(selectVisibleTasks(finished), []);
});

test("a running task keeps its row, and leaves as soon as its end state arrives", () => {
  const running = task("a", "running");
  assert.deepEqual(ids(selectVisibleTasks([running])), ["a"]);

  // No post-exit grace window: the row goes the moment the registry reports
  // the task ended, even though the registry keeps it as history.
  const ended = { ...running, state: "exited", exitCode: 0 };
  assert.deepEqual(selectVisibleTasks([ended]), []);
});

test("a pending continuation keeps its row until the decision is made", () => {
  const pending = task("a", "exited", { exitCode: 0, continuation: "pending" });
  assert.deepEqual(ids(selectVisibleTasks([pending])), ["a"]);

  const settled = { ...pending, continuation: "started" };
  assert.deepEqual(selectVisibleTasks([settled]), []);
});

test("the row whose output is being read stays until the reader closes it", () => {
  const ended = task("a", "exited", { exitCode: 0 });
  assert.deepEqual(ids(selectVisibleTasks([ended], "a")), ["a"]);
  // A different task's open preview does not pin this one.
  assert.deepEqual(selectVisibleTasks([ended], "b"), []);
});

test("a running task is visible whether or not its output is open", () => {
  const running = task("a", "running");
  assert.deepEqual(ids(selectVisibleTasks([running])), ["a"]);
  assert.deepEqual(ids(selectVisibleTasks([running], "a")), ["a"]);
});
