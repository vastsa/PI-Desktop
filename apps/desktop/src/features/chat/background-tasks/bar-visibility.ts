import type { BackgroundTaskSummary } from "../../../lib/api";

/**
 * Which rows the tasks bar may render.
 *
 * The registry in host-core keeps every finished task as readable history; the
 * bar answers only to the live present: a task the session is still running,
 * or one whose continuation decision is still pending, plus the single row
 * whose output the user is reading, so an open log cannot vanish underneath
 * it (#2632).
 */

/**
 * The rows the bar may render right now: live tasks — running, or waiting on a
 * continuation decision — always, plus the task whose output the user is
 * reading (`pinnedId`). A task that already ended when the renderer first
 * listed it is registry history and never gets a row.
 */
export function selectVisibleTasks(
  tasks: readonly BackgroundTaskSummary[],
  pinnedId: string | null = null,
): BackgroundTaskSummary[] {
  return tasks.filter(
    (task) =>
      task.state === "running" ||
      task.continuation === "pending" ||
      task.id === pinnedId,
  );
}
