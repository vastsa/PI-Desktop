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
const { isReading, sidesFor, visibleDockTab } = await import("../src/features/chat/background-tasks/dock-state.ts");

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
 * The pin on a row being read, driven the way the hook composes it: the rows
 * carry the pin, the sides describe them, `isReading` says whether the preview
 * is on screen, and `visibleDockTab` keeps the tasks panel under it. When the
 * preview leaves the screen the hook closes the pin — unless the task is
 * still running, whose preview survives the switch and picks up the same
 * read when the user returns (#2634).
 */

test("regression: the row being read stays while its preview is on screen", () => {
  // start → open output: the task finishes while the user reads it.
  const running = task("a", "running");
  const dock = { chosenTab: "tasks", collapsed: false };
  const rows = selectVisibleTasks([running], "a");
  const sides = sidesFor(rows, []);
  assert.equal(visibleDockTab(dock, sides, isReading(dock, sides, "a")), "tasks");

  const ended = { ...running, state: "exited", exitCode: 0 };
  assert.deepEqual(ids(selectVisibleTasks([ended], "a")), ["a"]);
  // The pinned row keeps the tasks side non-empty, so the panel — and the
  // read — survives the task ending underneath it.
  const pinnedSides = sidesFor(selectVisibleTasks([ended], "a"), []);
  assert.equal(visibleDockTab(dock, pinnedSides, isReading(dock, pinnedSides, "a")), "tasks");
});

test("regression: the auto tab rule does not take the panel from an open read", () => {
  // A user who never chose a tab, with an in-progress todo, reads the only
  // running task's output; the task ends mid-read.
  const todos = [{ status: "in_progress" }];
  const dock = { chosenTab: null, collapsed: false };
  const running = task("a", "running");
  assert.equal(visibleDockTab(dock, sidesFor([running], todos), false), "tasks");

  const ended = { ...running, state: "exited", exitCode: 0 };
  const rows = selectVisibleTasks([ended], "a");
  const sides = sidesFor(rows, todos);
  assert.equal(isReading(dock, sides, "a"), true);
  // The panel stays on the tasks tab, so the row being read stays too.
  assert.equal(visibleDockTab(dock, sides, isReading(dock, sides, "a")), "tasks");
  // Choosing Todo — the one user action that ends the read — still does.
  assert.equal(isReading({ ...dock, chosenTab: "todo" }, sides, "a"), false);
});

test("regression: a finished row whose preview left the screen cannot reappear", () => {
  const todos = [{ status: "in_progress" }];
  const started = task("a", "running");
  const dock = { chosenTab: "tasks", collapsed: false };

  // start → open output: the preview is on screen, the row is pinned.
  const rows = selectVisibleTasks([started], "a");
  const sides = sidesFor(rows, todos);
  assert.equal(isReading(dock, sides, "a"), true);

  // → collapse (or switch to Todo): the preview is no longer on screen, so
  // the hook closes the pin — the running task's pin survives, but it goes
  // as soon as the task ends while hidden. That the hook closes it is pinned
  // by the source contract test in background-tasks.test.mjs.
  assert.equal(isReading({ ...dock, collapsed: true }, sides, "a"), false);
  assert.equal(isReading({ ...dock, chosenTab: "todo" }, sides, "a"), false);

  // → finish while hidden, then reopen: the ended row must not reappear.
  const ended = { ...started, state: "exited", exitCode: 0 };
  assert.deepEqual(selectVisibleTasks([ended], null), []);
});

test("regression: a running task's preview survives switching away and back", () => {
  // The E2E scenario E2E-TASK-DOCK-tab-content-isolation: open a running
  // task's log, switch to Todo and back — the read picks up where it left
  // off (#2634).
  const started = task("a", "running");
  const todos = [{ status: "in_progress" }];
  const dock = { chosenTab: "tasks", collapsed: false };
  const sides = sidesFor(selectVisibleTasks([started], "a"), todos);
  assert.equal(isReading(dock, sides, "a"), true);

  // Switch to Todo: the preview leaves the screen, but the task runs, so the
  // hook keeps the pin.
  assert.equal(isReading({ ...dock, chosenTab: "todo" }, sides, "a"), false);
  assert.equal(started.state, "running");

  // Switch back: the preview is on screen again, the row is live, and the
  // same read continues.
  const rows = selectVisibleTasks([started], "a");
  assert.deepEqual(ids(rows), ["a"]);
  assert.equal(visibleDockTab(dock, sides, isReading(dock, sides, "a")), "tasks");
});
