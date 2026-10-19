import type { BackgroundTaskSummary } from "../../../lib/api";

/**
 * How long a finished task stays in the bar after the renderer watched it
 * running. Long enough to read the exit code, short enough that a command that
 * completed minutes ago does not become a permanent resident above the
 * composer.
 */
export const ENDED_VISIBLE_MS = 10_000;

/** Visibility bookkeeping owned by the renderer, never persisted or sent. */
export type BarVisibility = {
  /** Tasks observed as running at least once in this renderer session. */
  seenRunning: ReadonlySet<string>;
  /** Subset of `seenRunning` that has finished since, with the observation time. */
  endedAt: ReadonlyMap<string, number>;
  /** Tasks the user closed from the bar. */
  dismissed: ReadonlySet<string>;
};

export const EMPTY_VISIBILITY: BarVisibility = {
  seenRunning: new Set(),
  endedAt: new Map(),
  dismissed: new Set(),
};

function pruneSet(source: ReadonlySet<string>, liveIds: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const id of source) {
    if (liveIds.has(id)) next.add(id);
  }
  return next;
}

function pruneMap(
  source: ReadonlyMap<string, number>,
  liveIds: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, at] of source) {
    if (liveIds.has(id)) next.set(id, at);
  }
  return next;
}

/**
 * Fold one registry snapshot into the visibility bookkeeping.
 *
 * A task that is already finished the first time the renderer sees it is
 * registry history — it may have ended before the window opened — so it never
 * becomes visible. Only a task observed running gets the post-exit grace
 * window. Entries for tasks the registry dropped are pruned, so the
 * bookkeeping cannot grow across a long session.
 *
 * Returns the previous state when nothing changed, so callers can skip work.
 */
export function observeTasks(
  state: BarVisibility,
  tasks: readonly BackgroundTaskSummary[],
  now: number,
): BarVisibility {
  const liveIds = new Set(tasks.map((task) => task.id));
  const seenRunning = pruneSet(state.seenRunning, liveIds);
  const endedAt = pruneMap(state.endedAt, liveIds);
  const dismissed = pruneSet(state.dismissed, liveIds);
  let changed =
    seenRunning.size !== state.seenRunning.size ||
    endedAt.size !== state.endedAt.size ||
    dismissed.size !== state.dismissed.size;

  for (const task of tasks) {
    if (task.state === "running") {
      if (!seenRunning.has(task.id)) {
        seenRunning.add(task.id);
        changed = true;
      }
      if (endedAt.delete(task.id)) changed = true;
      continue;
    }
    if (seenRunning.has(task.id) && !endedAt.has(task.id)) {
      endedAt.set(task.id, now);
      changed = true;
    }
  }

  if (!changed) return state;
  return { seenRunning, endedAt, dismissed };
}

/**
 * Tasks the bar may render right now: running ones always, finished ones only
 * inside the grace window or while the user is reading their output
 * (`pinnedId`), and never ones the user closed.
 */
export function selectVisibleTasks(
  state: BarVisibility,
  tasks: readonly BackgroundTaskSummary[],
  now: number,
  pinnedId: string | null = null,
): BackgroundTaskSummary[] {
  return tasks.filter((task) => {
    if (state.dismissed.has(task.id)) return false;
    if (task.state === "running") return true;
    // Reading the log of a finished command must not be interrupted by the
    // grace window expiring underneath it.
    if (task.id === pinnedId) return true;
    const ended = state.endedAt.get(task.id);
    return ended !== undefined && now - ended < ENDED_VISIBLE_MS;
  });
}

/**
 * When the next grace window closes, or `null` when no visible row is about to
 * expire. The caller schedules a single timer for this instant instead of
 * polling for the bar to shrink.
 */
export function nextExpiryAt(
  state: BarVisibility,
  tasks: readonly BackgroundTaskSummary[],
  now: number,
  pinnedId: string | null = null,
): number | null {
  let earliest: number | null = null;
  for (const task of selectVisibleTasks(state, tasks, now, pinnedId)) {
    if (task.id === pinnedId) continue;
    const ended = state.endedAt.get(task.id);
    if (ended === undefined) continue;
    const expiry = ended + ENDED_VISIBLE_MS;
    if (earliest === null || expiry < earliest) earliest = expiry;
  }
  return earliest;
}

/** Hide one row from the bar. Runs nowhere near the process lifecycle. */
export function dismissTask(state: BarVisibility, id: string): BarVisibility {
  if (state.dismissed.has(id)) return state;
  const dismissed = new Set(state.dismissed);
  dismissed.add(id);
  return { ...state, dismissed };
}
