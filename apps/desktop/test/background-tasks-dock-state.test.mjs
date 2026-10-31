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
  EMPTY_DOCK_VIEW,
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

/** A container the user has opened, with one session's state patched in. */
const view = (patch) => ({
  sessions: { [SESSION]: { ...EMPTY_SESSION_DOCK, ...patch, collapsed: false } },
  collapsed: false,
});
/** A view holding exactly one session entry, as a tab choice would leave it. */
const withSessionState = (state, id, patch) => ({
  ...state,
  sessions: { ...state.sessions, [id]: { ...EMPTY_SESSION_DOCK, ...patch, collapsed: state.collapsed } },
});
const viewOf = (state) => ({ sessions: { [SESSION]: state }, collapsed: state.collapsed });

test("an unknown session starts from the empty state", () => {
  assert.deepEqual(sessionDockState(EMPTY_DOCK_VIEW, SESSION), EMPTY_SESSION_DOCK);
  assert.equal(sessionDockState(view({ chosenTab: "tasks" }), SESSION).chosenTab, "tasks");
  // No session means no view state to read.
  assert.equal(sessionDockState(view({ chosenTab: "tasks" }), null), EMPTY_SESSION_DOCK);
});

test("the container starts collapsed, so the composer keeps its room", () => {
  assert.equal(EMPTY_DOCK_VIEW.collapsed, true);
  assert.equal(sessionDockState(EMPTY_DOCK_VIEW, SESSION).collapsed, true);
  // A session that never had its own entry reads the container-wide answer.
  assert.equal(sessionDockState(EMPTY_DOCK_VIEW, "session-2").collapsed, true);
});

test("clicking a tab while collapsed also expands the container", () => {
  // D15: the click must not only swap an invisible panel, or it would look
  // like it did nothing.
  const collapsed = { ...view({}), collapsed: true };
  const opened = selectTab(collapsed, SESSION, "tasks");

  assert.equal(sessionDockState(opened, SESSION).collapsed, false);
  assert.equal(sessionDockState(opened, SESSION).chosenTab, "tasks");
});

test("clicking the already-active tab while collapsed still expands", () => {
  const collapsed = { ...view({ chosenTab: "tasks" }), collapsed: true };
  const opened = selectTab(collapsed, SESSION, "tasks");
  assert.equal(sessionDockState(opened, SESSION).collapsed, false);
});

test("only a user action writes the remembered tab", () => {
  // Folding a snapshot into the badge must never overwrite what the user chose.
  const chosen = chooseTab(EMPTY_DOCK_VIEW, SESSION, "todo");
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
  const remembered = { ...EMPTY_SESSION_DOCK, chosenTab: "tasks", collapsed: false };
  assert.equal(resolveDockTab(remembered, true, false, 0, 0), "todo");
  const rememberedTodo = { ...EMPTY_SESSION_DOCK, chosenTab: "todo", collapsed: false };
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
  const open = { ...EMPTY_SESSION_DOCK, collapsed: false };
  assert.equal(tasksPanelVisible(open, sides), true);
  assert.equal(tasksPanelVisible(EMPTY_SESSION_DOCK, sides), false);
  // The todo panel on screen is not the tasks panel either.
  const onTodo = { ...open, chosenTab: "todo" };
  assert.equal(tasksPanelVisible(onTodo, sides), false);
});

test("the render rule and the badge rule share one tab decision", () => {
  // Both read `resolveDockTabFor`, so they cannot disagree about which panel is
  // on screen. This is the invariant the old duplicated call broke.
  const sides = { hasTodo: true, hasTasks: true, runningTasks: 1, inProgressTodos: 1 };
  const state = { ...EMPTY_SESSION_DOCK, collapsed: false };
  assert.equal(resolveDockTabFor(state, sides), "tasks");
  assert.equal(tasksPanelVisible(state, sides), true);
});

test("a new task raises the badge only while the tasks panel is not on screen", () => {
  const seen = new Set();
  const raised = observeSessionTasks(EMPTY_DOCK_VIEW, SESSION, [task("a"), task("b")], {
    knownIds: seen,
    tasksVisible: false,
  });
  assert.equal(sessionDockState(raised.view, SESSION).newCount, 2);
  assert.deepEqual([...raised.knownIds].sort(), ["a", "b"]);

  const quiet = observeSessionTasks(EMPTY_DOCK_VIEW, SESSION, [task("a")], {
    knownIds: new Set(),
    tasksVisible: true,
  });
  assert.equal(sessionDockState(quiet.view, SESSION).newCount, 0);
});

test("the same snapshot re-read does not count a task twice", () => {
  const first = observeSessionTasks(EMPTY_DOCK_VIEW, SESSION, [task("a")], {
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
  const finished = observeSessionTasks(EMPTY_DOCK_VIEW, SESSION, [task("a", "exited")], {
    knownIds: new Set(),
    tasksVisible: false,
  });
  assert.equal(sessionDockState(finished.view, SESSION).newCount, 0);
});

test("entering the tasks tab is the only clear point for the badge", () => {
  const raised = observeSessionTasks(EMPTY_DOCK_VIEW, SESSION, [task("a")], {
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
  const opened = toggleCollapsed(EMPTY_DOCK_VIEW);
  assert.equal(opened.collapsed, false);
  assert.equal(sessionDockState(opened, SESSION).collapsed, false);
  const collapsed = toggleCollapsed(opened);
  assert.equal(collapsed.collapsed, true);
  assert.equal(sessionDockState(collapsed, SESSION).collapsed, true);
});

test("a closed container stays closed after switching sessions", () => {
  // The regression: the collapse used to be stored per session, so the next
  // session's own default reopened what the user had just closed.
  const closed = viewOf({ ...EMPTY_SESSION_DOCK, chosenTab: "tasks" });
  assert.equal(sessionDockState(closed, SESSION).collapsed, true);
  assert.equal(sessionDockState(closed, "session-2").collapsed, true);
  // The tab choice stays per session, the collapse does not.
  assert.equal(sessionDockState(closed, "session-2").chosenTab, null);

  // Entering a tab is the one user action that expands the shared container.
  const reopened = selectTab(closed, "session-2", "todo");
  assert.equal(reopened.collapsed, false);
  assert.equal(sessionDockState(reopened, SESSION).collapsed, false);
  assert.equal(sessionDockState(reopened, SESSION).chosenTab, "tasks");
});

test("badge text hides at zero and collapses long counts", () => {
  assert.equal(badgeLabel(0), "0");
  assert.equal(badgeLabel(3), "3");
  assert.equal(badgeLabel(9), "9");
  assert.equal(badgeLabel(10), "9+");
});

test("view state is dropped for sessions that no longer exist", () => {
  // A session that has its own entry, with no second session ever seen.
  const kept = withSessionState(EMPTY_DOCK_VIEW, SESSION, { chosenTab: "tasks" });
  const both = toggleCollapsed(kept);

  // Pruning the dead session rebuilds the map, so identity is not the contract;
  // the surviving entry must be untouched.
  const pruned = pruneDockView(both, new Set([SESSION]));
  assert.deepEqual(pruned.sessions, kept.sessions);
  assert.equal(pruned.collapsed, both.collapsed);
  // An unchanged map keeps its identity so a render is not forced.
  assert.equal(pruneDockView(kept, new Set([SESSION])), kept);
});
