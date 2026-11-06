/**
 * Sidebar project "running" affordance resolution.
 *
 * A project group header must answer "is anything under me actually
 * running?" while the group is collapsed, so the signal cannot live only on
 * the session rows: `.sidebar-session-group-body.project.collapsed` folds to
 * `0fr` and goes `inert`, which hides every row-level status dot.
 *
 * This module owns the two decisions that rendering must not re-derive:
 * which projects have live work, and whether a given affordance is on.
 * Both are pure so they are testable without a renderer.
 */

/** Live counts for one project group, local or remote. */
export type ProjectRunSummary = {
  /** Sessions with an in-flight turn. */
  running: number;
  /** Sessions blocked on a permission prompt. */
  waiting: number;
  /** Sessions shown under this project (used for the `n / total` read). */
  total: number;
};

export const EMPTY_PROJECT_RUN_SUMMARY: ProjectRunSummary = {
  running: 0,
  waiting: 0,
  total: 0,
};

/** Minimal session shape needed to classify one row. */
export type ProjectRunSession = { id: string };

/**
 * The two sidebar affordances plus the numeric readout that travels with the
 * rail. The master switch gates all of them; absent sub-switches mean "on"
 * while the master must be explicitly enabled, so an install that never opted
 * in stays quiet, and turning the master off disables everything regardless of
 * how the sub-switches are stored.
 */
export type SidebarRunningAffordances = {
  /** Count capsules after the project name. */
  badge: boolean;
  /** Activity track down the group's left edge. */
  rail: boolean;
  /**
   * The figures that accompany the rail. They restate the badge, so they only
   * render while the badge is off: with both sub-switches on the header would
   * otherwise print the same counts twice (`.project-run-count` is documented
   * as the badge's stand-in, not an addition to it).
   */
  railCount: boolean;
};

export function resolveSidebarRunningAffordances(
  settings?:
    | {
        sidebarRunningIndicators?: boolean;
        sidebarRunningBadge?: boolean;
        sidebarRunningRail?: boolean;
      }
    | null,
): SidebarRunningAffordances {
  const master = settings?.sidebarRunningIndicators === true;
  const badge = master && settings?.sidebarRunningBadge !== false;
  const rail = master && settings?.sidebarRunningRail !== false;
  return { badge, rail, railCount: rail && !badge };
}

/**
 * Classify one project's sessions. `runningSessions` and `pendingPermissions`
 * are keyed by session id, matching the store's shape.
 */
export function summarizeProjectRuns(
  sessions: readonly ProjectRunSession[],
  runningSessions: Record<string, boolean | undefined>,
  pendingPermissions: Record<string, readonly unknown[] | undefined>,
): ProjectRunSummary {
  let running = 0;
  let waiting = 0;
  for (const session of sessions) {
    if ((pendingPermissions[session.id]?.length ?? 0) > 0) {
      waiting += 1;
    } else if (runningSessions[session.id]) {
      running += 1;
    }
  }
  return { running, waiting, total: sessions.length };
}

/** True when the group deserves an affordance at all. */
export function projectRunSummaryIsLive(summary: ProjectRunSummary): boolean {
  return summary.running > 0 || summary.waiting > 0;
}

/** Total live sessions across every group; drives the section-level summary. */
export function totalRunningProjects(
  summaries: readonly ProjectRunSummary[],
): number {
  return summaries.reduce(
    (count, summary) => count + (projectRunSummaryIsLive(summary) ? 1 : 0),
    0,
  );
}
