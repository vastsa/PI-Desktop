import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";

export type ScheduledRunStatus = ScheduledTaskRun["status"];

/** Stable order for a horizontal band of runs: newest first, ties by id. */
function compareRunsDescending(left: ScheduledTaskRun, right: ScheduledTaskRun): number {
  const started = Date.parse(right.startedAt) - Date.parse(left.startedAt);
  if (Number.isFinite(started) && started !== 0) return started;
  return right.id.localeCompare(left.id);
}

/** Newest first. The host orders runs by `startedAt DESC`; regrouping must not
 * reorder them, so every view reads its rows through this function. */
export function sortRunsNewestFirst(runs: readonly ScheduledTaskRun[]): ScheduledTaskRun[] {
  return [...runs].sort(compareRunsDescending);
}

/** One task's own history, newest first. */
export function runsForTask(
  runs: readonly ScheduledTaskRun[],
  taskId: string | null | undefined,
): ScheduledTaskRun[] {
  if (!taskId) return [];
  return sortRunsNewestFirst(runs.filter((run) => run.taskId === taskId));
}

/** The newest run of every task, so a task row can report its own outcome
 * without asking the host once per task. */
export function latestRunByTask(
  runs: readonly ScheduledTaskRun[],
): Map<string, ScheduledTaskRun> {
  const latest = new Map<string, ScheduledTaskRun>();
  for (const run of sortRunsNewestFirst(runs)) {
    if (!latest.has(run.taskId)) latest.set(run.taskId, run);
  }
  return latest;
}

/** Wall-clock length of a finished run. `null` while it still runs, or when the
 * stored times cannot be compared. */
export function runDurationMs(run: ScheduledTaskRun | null | undefined): number | null {
  if (!run || !run.endedAt) return null;
  const started = Date.parse(run.startedAt);
  const ended = Date.parse(run.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return ended - started;
}

/** True when a task currently holds an in-flight run. A run stays `running`
 * until the host records its terminal status, so the row can say so. */
export function taskIsRunning(
  runs: readonly ScheduledTaskRun[],
  taskId: string | null | undefined,
): boolean {
  if (!taskId) return false;
  return runs.some((run) => run.taskId === taskId && run.status === "running");
}

/** The run a history view should read: the caller's pick while it still exists,
 * otherwise the newest one. Selection survives a refresh that keeps the row. */
export function resolveSelectedRun(
  runs: readonly ScheduledTaskRun[],
  runId: string | null | undefined,
): ScheduledTaskRun | null {
  const ordered = sortRunsNewestFirst(runs);
  if (runId) {
    const match = ordered.find((run) => run.id === runId);
    if (match) return match;
  }
  return ordered[0] ?? null;
}

/** Whether the selected run is the one a run-detail surface should load. */
export function selectedRunSessionId(
  runs: readonly ScheduledTaskRun[],
  runId: string | null | undefined,
): string | null {
  return resolveSelectedRun(runs, runId)?.sessionId ?? null;
}

/** A task row's status line: the outcome of its newest run. */
export function latestRunForTask(
  runs: readonly ScheduledTaskRun[],
  taskId: string | null | undefined,
): ScheduledTaskRun | null {
  if (!taskId) return null;
  return runsForTask(runs, taskId)[0] ?? null;
}

/** The task the workspace keeps selected: the caller's pick while that task
 * still exists, otherwise the first one. A selection restored from a
 * conversation must survive the first read — an empty list is not a verdict
 * on whether the task exists. */
export function resolveSelectedTaskId(
  tasks: readonly ScheduledTask[],
  selectedTaskId: string | null | undefined,
  loaded: boolean,
): string | null {
  if (!loaded) return selectedTaskId ?? null;
  if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) return selectedTaskId;
  return tasks[0]?.id ?? null;
}
