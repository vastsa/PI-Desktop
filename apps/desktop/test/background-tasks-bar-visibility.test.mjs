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
const { sidesFor, tasksPanelVisible } = await import("../src/features/chat/background-tasks/dock-state.ts");

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

/*
 * The pin on a row being read lives only while its preview is on screen.
 * The pieces the hook composes are pure, so the regression drives them the
 * way the hook does: the rows carry the pin, the sides describe them, and
 * `tasksPanelVisible` decides whether the preview is on screen; when it is
 * not, the hook closes the preview (`expandedId` becomes null) (#2634).
 */

test("regression: the row being read stays while its preview is on screen", () => {
  // start → open output: the task finishes while the user reads it.
  const running = task("a", "running");
  const dock = { chosenTab: "tasks", collapsed: false };
  const rows = selectVisibleTasks([running], "a");
  assert.equal(tasksPanelVisible(dock, sidesFor(rows, [])), true);

  const ended = { ...running, state: "exited", exitCode: 0 };
  assert.deepEqual(ids(selectVisibleTasks([ended], "a")), ["a"]);
  // The pinned row keeps the tasks side non-empty, so the panel — and the
  // read — survives the task ending underneath it.
  assert.equal(tasksPanelVisible(dock, sidesFor(selectVisibleTasks([ended], "a"), [])), true);
});

test("regression: a finished row whose preview left the screen cannot reappear", () => {
  const todos = [{ status: "in_progress" }];
  const started = task("a", "running");
  const dock = { chosenTab: "tasks", collapsed: false };

  // start → open output: the preview is on screen, the row is pinned.
  const rows = selectVisibleTasks([started], "a");
  assert.equal(tasksPanelVisible(dock, sidesFor(rows, todos)), true);

  // → collapse (or switch to Todo): the preview is no longer on screen, so
  // the hook closes it — `expandedId` becomes null before the task ends.
  assert.equal(tasksPanelVisible({ ...dock, collapsed: true }, sidesFor(rows, todos)), false);
  assert.equal(
    tasksPanelVisible({ ...dock, chosenTab: "todo" }, sidesFor(rows, todos)),
    false,
  );

  // → finish, then reopen: the ended row must not reappear. That the hook
  // really closes the preview when the panel hides is asserted by the source
  // contract test in background-tasks.test.mjs.
  const ended = { ...started, state: "exited", exitCode: 0 };
  assert.deepEqual(selectVisibleTasks([ended], null), []);
});
