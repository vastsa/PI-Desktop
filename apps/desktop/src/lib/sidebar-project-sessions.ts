/**
 * How many sessions a project group shows before the remaining ones fold
 * behind the "load more" row (#2584). The count is user configurable through
 * Appearance → Sidebar, so the bounds live here: the settings row, the IPC
 * guard, and the sidebar itself all read the same numbers.
 */
export const MIN_VISIBLE_PROJECT_SESSION_COUNT = 1;
export const MAX_VISIBLE_PROJECT_SESSION_COUNT = 20;
export const DEFAULT_VISIBLE_PROJECT_SESSION_COUNT = 10;

/**
 * Resolves a stored setting to a count the sidebar can slice with. Values
 * outside the supported range, non-integers, and absent settings fall back to
 * the default instead of throwing: a hand-edited settings file must not break
 * the sidebar.
 */
export function normalizeVisibleProjectSessionCount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_VISIBLE_PROJECT_SESSION_COUNT ||
    parsed > MAX_VISIBLE_PROJECT_SESSION_COUNT
  ) {
    return DEFAULT_VISIBLE_PROJECT_SESSION_COUNT;
  }
  return parsed;
}

export function updateProjectSessionExpansion(
  expandedByProject: Record<string, boolean>,
  projectKey: string,
  expanded: boolean,
): Record<string, boolean> {
  if (expanded) return { ...expandedByProject, [projectKey]: true };

  const next = { ...expandedByProject };
  delete next[projectKey];
  return next;
}

export function getVisibleProjectSessions<T>(
  sessions: T[],
  expanded: boolean,
  limit: unknown = DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
): { visibleSessions: T[]; hiddenCount: number } {
  const visibleSessions = expanded
    ? sessions
    : sessions.slice(0, normalizeVisibleProjectSessionCount(limit));

  return {
    visibleSessions,
    hiddenCount: sessions.length - visibleSessions.length,
  };
}

export type ProjectCollapseAllAction = "collapse" | "expand";

/**
 * One button folds or unfolds every project group (#2584).
 *
 * Any group still open means the click collapses them all; only when every
 * group is already folded does the click reopen them. That keeps the mixed
 * state on the "collapse" side, so the control never needs a third state and
 * the label always describes the action the next click performs. Callers
 * disable the control when there is no group to act on.
 */
export function resolveProjectCollapseAllAction(
  collapsedFlags: Iterable<boolean>,
): ProjectCollapseAllAction {
  let sawProject = false;
  for (const collapsed of collapsedFlags) {
    sawProject = true;
    if (!collapsed) return "collapse";
  }
  return sawProject ? "expand" : "collapse";
}
