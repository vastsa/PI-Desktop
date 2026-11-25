/** Rows the Recent sessions list shows before the first Load more. */
export const RECENT_SESSIONS_INITIAL_COUNT = 7;
/** Rows each Load more click appends to the Recent sessions list. */
export const RECENT_SESSIONS_PAGE_SIZE = 10;

interface RecentSessionLike {
  id: string;
  updatedAt?: string | null;
}

function recentTimestamp(value?: string | null): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * Every listable session across projects and temporary chats, newest first.
 * Project sessions intentionally appear here as well as in their project
 * group so they stay reachable while the project is folded. Rows already
 * shown in the Pinned section are left out.
 */
export function selectRecentSessions<T extends RecentSessionLike>(
  sessions: readonly T[],
  excludedIds: ReadonlySet<string>,
): T[] {
  return sessions
    .filter((session) => !excludedIds.has(session.id))
    .sort((a, b) => {
      const byRecent = recentTimestamp(b.updatedAt) - recentTimestamp(a.updatedAt);
      if (byRecent !== 0 && !Number.isNaN(byRecent)) return byRecent;
      return a.id.localeCompare(b.id);
    });
}

export function getVisibleRecentSessions<T>(
  sessions: readonly T[],
  limit: number,
): { visibleSessions: T[]; nextPageCount: number } {
  const visibleSessions = sessions.slice(0, Math.max(0, limit));
  const hidden = sessions.length - visibleSessions.length;
  return {
    visibleSessions,
    nextPageCount: Math.min(hidden, RECENT_SESSIONS_PAGE_SIZE),
  };
}

export function nextRecentSessionsLimit(limit: number): number {
  return limit + RECENT_SESSIONS_PAGE_SIZE;
}
