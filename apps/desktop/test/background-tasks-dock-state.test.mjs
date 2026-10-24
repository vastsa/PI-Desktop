import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The shared container's view state. These pin the rules a user can observe:
 * which panel is on screen, when a new task raises a badge, and what a click on
 * a tab does while the container is collapsed. All of it is plain renderer
 * memory, so a controlled input decides every case.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  EMPTY_SESSION_DOCK,
  badgeLabel,
  chooseTab,
  clearBadge,
  observeSessionTasks,
  pruneDockView,
  resolveDockTab,
  resolveDockTabFor,
  selectTab,
  sessionDockState,
  tasksPanelVisible,
  toggleCollapsed,
} = await import("../src/features/chat/background-tasks/dock-state.ts");

const SESSION = "session-1";

const task = (id, state = "running") => ({
  id,
  sessionId: SESSION,
  command: `cmd ${id}`,
  commandShellId: "bash",
  state,
  elapsedMs: 1_000,
});

const view = (patch) => ({ [SESSION]: { ...EMPTY_SESSION_DOCK, ...patch } });

test("an unknown session starts from the empty state", () => {
  assert.equal(sessionDockState({}, SESSION), EMPTY_SESSION_DOCK);
  assert.equal(sessionDockState(view({ collapsed: true }), SESSION).collapsed, true);
  // No session means no view state to read.
  assert.equal(sessionDockState(view({ collapsed: true }), null), EMPTY_SESSION_DOCK);
});

test("clicking a tab while collapsed also expands the container", () => {
  // D15: the click must not only swap an invisible panel, or it would look
  // like it did nothing.
  const collapsed = view({ collapsed: true });
  const opened = selectTab(collapsed, SESSION, "tasks");

  assert.equal(sessionDockState(opened, SESSION).collapsed, false);
  assert.equal(sessionDockState(opened, SESSION).chosenTab, "tasks");
});

test("clicking the already-active tab while collapsed still expands", () => {
  const collapsed = view({ collapsed: true, chosenTab: "tasks" });
  const opened = selectTab(collapsed, SESSION, "tasks");
  assert.equal(sessionDockState(opened, SESSION).collapsed, false);
});

test("only a user action writes the remembered tab", () => {
  // Folding a snapshot into the badge must never overwrite what the user chose.
  const chosen = chooseTab({}, SESSION, "todo");
  const afterBadge = observeSessionTasks(chosen, SESSION, [task("a")], {
    knownIds: new Set(),
    tasksVisible: false,
  });
  assert.equal(sessionDockState(afterBadge.view, SESSION).chosenTab, "todo");
});

test("the remember-chosen tab wins while its side has content", () => {
  const state = sessionDockState(view({ chosenTab: "todo" }), SESSION);
  assert.equal(resolveDockTab(state, true, true, 3, 0), "todo");
  assert.equal(
    resolveDockTab({ ...state, chosenTab: "tasks" }, true, true, 0, 3),
    "tasks",
  );
});

test("with nothing remembered the content decides, running work first", () => {
  const state = EMPTY_SESSION_DOCK;
  assert.equal(resolveDockTab(state, true, true, 1, 1), "tasks");
  assert.equal(resolveDockTab(state, true, true, 0, 1), "todo");
  assert.equal(resolveDockTab(state, true, true, 0, 0), "todo");
});

test("a tab whose side is empty is never selected", () => {
  // A remembered tab that lost its content falls back to the other side.
  const remembered = { ...EMPTY_SESSION_DOCK, chosenTab: "tasks" };
  assert.equal(resolveDockTab(remembered, true, false, 0, 0), "todo");
  const rememberedTodo = { ...EMPTY_SESSION_DOCK, chosenTab: "todo" };
  assert.equal(resolveDockTab(rememberedTodo, false, true, 0, 0), "tasks");
});

test("one populated side renders alone, so the tab list is not rendered", () => {
  const sides = { hasTodo: true, hasTasks: false, runningTasks: 0, inProgressTodos: 1 };
  assert.equal(resolveDockTabFor(EMPTY_SESSION_DOCK, sides), "todo");
  // The container hides the tab list exactly when one side is empty.
  assert.equal(sides.hasTodo && sides.hasTasks, false);
});

test("a collapsed container never counts as looking at the tasks panel", () => {
  const sides = { hasTodo: true, hasTasks: true, runningTasks: 2, inProgressTodos: 0 };
  assert.equal(tasksPanelVisible(EMPTY_SESSION_DOCK, sides), true);
  assert.equal(
    tasksPanelVisible({ ...EMPTY_SESSION_DOCK, collapsed: true }, sides),
    false,
  );
  // The todo panel on screen is not the tasks panel either.
  const onTodo = { ...EMPTY_SESSION_DOCK, chosenTab: "todo" };
  assert.equal(tasksPanelVisible(onTodo, sides), false);
});

test("the render rule and the badge rule share one tab decision", () => {
  // Both read `resolveDockTabFor`, so they cannot disagree about which panel is
  // on screen. This is the invariant the old duplicated call broke.
  const sides = { hasTodo: true, hasTasks: true, runningTasks: 1, inProgressTodos: 1 };
  const state = EMPTY_SESSION_DOCK;
  assert.equal(resolveDockTabFor(state, sides), "tasks");
  assert.equal(tasksPanelVisible(state, sides), true);
});

test("a new task raises the badge only while the tasks panel is not on screen", () => {
  const seen = new Set();
  const raised = observeSessionTasks({}, SESSION, [task("a"), task("b")], {
    knownIds: seen,
    tasksVisible: false,
  });
  assert.equal(sessionDockState(raised.view, SESSION).newCount, 2);
  assert.deepEqual([...raised.knownIds].sort(), ["a", "b"]);

  const quiet = observeSessionTasks({}, SESSION, [task("a")], {
    knownIds: new Set(),
    tasksVisible: true,
  });
  assert.equal(sessionDockState(quiet.view, SESSION).newCount, 0);
});

test("the same snapshot re-read does not count a task twice", () => {
  const first = observeSessionTasks({}, SESSION, [task("a")], {
    knownIds: new Set(),
    tasksVisible: false,
  });
  assert.equal(sessionDockState(first.view, SESSION).newCount, 1);

  const again = observeSessionTasks(first.view, SESSION, [task("a")], {
    knownIds: first.knownIds,
    tasksVisible: false,
  });
  assert.equal(sessionDockState(again.view, SESSION).newCount, 1);
});

test("a task that is already finished is not new work", () => {
  const finished = observeSessionTasks({}, SESSION, [task("a", "exited")], {
    knownIds: new Set(),
    tasksVisible: false,
  });
  assert.equal(sessionDockState(finished.view, SESSION).newCount, 0);
});

test("entering the tasks tab is the only clear point for the badge", () => {
  const raised = observeSessionTasks({}, SESSION, [task("a")], {
    knownIds: new Set(),
    tasksVisible: false,
  });
  // Re-reading the list with the panel still hidden keeps the badge.
  const still = observeSessionTasks(raised.view, SESSION, [task("a")], {
    knownIds: raised.knownIds,
    tasksVisible: false,
  });
  assert.equal(sessionDockState(still.view, SESSION).newCount, 1);

  const cleared = clearBadge(chooseTab(still.view, SESSION, "tasks"), SESSION);
  assert.equal(sessionDockState(cleared, SESSION).newCount, 0);
  // The remembered tab survives the clear.
  assert.equal(sessionDockState(cleared, SESSION).chosenTab, "tasks");
});

test("collapse is one container-wide condition, both tabs share it", () => {
  const collapsed = toggleCollapsed({}, SESSION);
  assert.equal(sessionDockState(collapsed, SESSION).collapsed, true);
  assert.equal(sessionDockState(toggleCollapsed(collapsed, SESSION), SESSION).collapsed, false);
});

test("badge text hides at zero and collapses long counts", () => {
  assert.equal(badgeLabel(0), "0");
  assert.equal(badgeLabel(3), "3");
  assert.equal(badgeLabel(9), "9");
  assert.equal(badgeLabel(10), "9+");
});

test("view state is dropped for sessions that no longer exist", () => {
  const kept = toggleCollapsed(chooseTab({}, SESSION, "tasks"), SESSION);
  const both = toggleCollapsed(kept, "session-2");

  // Pruning the dead session rebuilds the map, so identity is not the contract;
  // the surviving entry must be untouched.
  assert.deepEqual(pruneDockView(both, new Set([SESSION])), kept);
  // An unchanged map keeps its identity so a render is not forced.
  assert.equal(pruneDockView(kept, new Set([SESSION])), kept);
});
