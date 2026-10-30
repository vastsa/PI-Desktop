import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { normalizeProjectPath } from "../../lib/sidebar-preferences";
import { summarizeProjectRuns } from "../../lib/sidebar-project-runs";

/** Only an explicit workspace binding gives a task a sidebar project. */
export function groupScheduledSidebarTasks(tasks: readonly ScheduledTask[]): Map<string, ScheduledTask[]> {
  const groups = new Map<string, ScheduledTask[]>();
  for (const task of tasks) {
    const path = normalizeProjectPath(task.workspacePath);
    if (!path) continue;
    const group = groups.get(path) ?? [];
    group.push(task);
    groups.set(path, group);
  }
  return groups;
}

/** Task activity stays visible on both the folder and its folded project. */
export function scheduledSidebarRunSummary(
  tasks: readonly ScheduledTask[],
  latestRuns: ReadonlyMap<string, ScheduledTaskRun>,
  pendingPermissions: Record<string, readonly unknown[] | undefined>,
) {
  const sessions = tasks.flatMap((task) => {
    const run = latestRuns.get(task.id);
    return run?.status === "running" ? [{ id: run.sessionId ?? run.id }] : [];
  });
  return {
    ...summarizeProjectRuns(sessions, Object.fromEntries(sessions.map(({ id }) => [id, true])), pendingPermissions),
    total: tasks.length,
  };
}
