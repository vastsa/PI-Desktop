import type { BackgroundTaskSummary } from "../../src/lib/api";

/**
 * Stand-in for `useBackgroundTasks` in the container's render tests.
 *
 * The hook's data source is the host registry, which is not reachable from a
 * static render, so the test installs the two lists the hook keeps apart:
 * `tasks` are the rows the container may render, `sessionTasks` are every
 * registry entry the host still lists for the session — including finished
 * tasks it keeps as history after their grace window closed. Keeping both in
 * the fixture is the point: the rendered container must answer only to
 * `tasks`.
 */
export type DockFixture = {
  tasks: BackgroundTaskSummary[];
  sessionTasks: BackgroundTaskSummary[];
  collapsed?: boolean;
};

declare global {
  // Installed by the render test before each render.
  var __piDockFixture: DockFixture | undefined;
}

export function useBackgroundTasks() {
  const fixture = globalThis.__piDockFixture ?? { tasks: [], sessionTasks: [] };
  return {
    tasks: fixture.tasks,
    sessionTasks: fixture.sessionTasks,
    activeTab: "tasks" as const,
    openTasksTab() {},
    openTodoTab() {},
    collapsed: fixture.collapsed ?? true,
    setCollapsed() {},
    badge: 0,
    badgeText: "0",
    expandedId: null,
    output: null,
    toggleOutput() {},
    stop() {},
    remove() {
      return true;
    },
    error: null,
    stoppingIds: new Set<string>(),
  };
}
