export const DEFAULT_VISIBLE_PROJECT_SESSION_COUNT = 10;

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
): { visibleSessions: T[]; hiddenCount: number } {
  const visibleSessions = expanded
    ? sessions
    : sessions.slice(0, DEFAULT_VISIBLE_PROJECT_SESSION_COUNT);

  return {
    visibleSessions,
    hiddenCount: sessions.length - visibleSessions.length,
  };
}
