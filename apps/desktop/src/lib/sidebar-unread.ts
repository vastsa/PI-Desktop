import type { AppNotification, SessionSummary } from "@pi-desktop/shared";
import {
  latestSessionOutcomes,
  type SidebarSessionOutcome,
} from "./sidebar-session-status";

export type HiddenUnreadState = {
  count: number;
  failed: boolean;
};

/**
 * The unread results a project group is rendering nowhere: the rows folded
 * behind "Load more" and, when the whole group is collapsed, every non-pinned
 * row in it.
 *
 * Pinned rows are always on screen, so callers pass the group's history with
 * them already removed — a pinned unread row needs no parent indicator. The
 * caller decides what is hidden because only it knows whether the group is
 * collapsed; this function only reads outcomes.
 */
export function hiddenUnreadState(
  hiddenSessions: readonly Pick<SessionSummary, "id">[],
  sessionOutcomes: Readonly<Record<string, SidebarSessionOutcome | undefined>>,
): HiddenUnreadState | null {
  let count = 0;
  let failed = false;

  for (const session of hiddenSessions) {
    const outcome = sessionOutcomes[session.id];
    if (!outcome) continue;
    count += 1;
    if (outcome === "failed") failed = true;
  }

  return count > 0 ? { count, failed } : null;
}

export type ScheduledUnread = {
  /** Sessions with an unread result, which is what the nav badge prints. */
  count: number;
  sessionIds: Set<string>;
  /** Per-session result, so a run row can pick its failed/completed dot. */
  outcomes: Record<string, SidebarSessionOutcome>;
};

/**
 * Unread results that belong to scheduled-task runs.
 *
 * Those transcripts are entered from the Scheduled page and never listed by the
 * session lists (issue #1291), so the Scheduled nav row and a task's run history
 * are the only places that can point at their unread state. The rows are read
 * from the same notification list the app badge counts, and the result is per
 * session — one session reports one result, its latest one, like `sessionOutcomes`.
 */
export function scheduledUnread(
  sessions: readonly Pick<SessionSummary, "id" | "scheduledRun">[],
  notifications: readonly AppNotification[],
): ScheduledUnread {
  const automation = new Set<string>();
  for (const session of sessions) {
    if (session.scheduledRun === true) automation.add(session.id);
  }

  const outcomes: Record<string, SidebarSessionOutcome> = {};
  for (const [sessionId, outcome] of Object.entries(
    latestSessionOutcomes([...notifications]),
  )) {
    if (automation.has(sessionId)) outcomes[sessionId] = outcome;
  }

  const sessionIds = new Set(Object.keys(outcomes));
  return { count: sessionIds.size, sessionIds, outcomes };
}