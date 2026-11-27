import type { AppNotification, SessionSummary } from "@pi-desktop/shared";
import { isAutomationSession } from "./session-origin.ts";

/**
 * The inbox lists every durable `task.failed` and `task.completed` outcome,
 * ordered so a result that needs attention still comes first (D689): unread
 * before read, failures before routine completions, then newest first. Hiding
 * completions (D295) made the shell badge count unread rows the bell could not
 * show, so the inbox keeps them and the ordering alone keeps a failure from
 * being buried. In normal use `inboxUnreadCount` therefore matches the host's
 * `unreadCount`.
 */
export function inboxNotifications(
  notifications: AppNotification[],
): AppNotification[] {
  return [...notifications].sort(compareInboxRows);
}

function compareInboxRows(
  left: AppNotification,
  right: AppNotification,
): number {
  const byRead = Number(Boolean(left.readAt)) - Number(Boolean(right.readAt));
  if (byRead !== 0) return byRead;

  const byKind =
    Number(left.kind !== "task.failed") - Number(right.kind !== "task.failed");
  if (byKind !== 0) return byKind;

  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  if (
    Number.isFinite(leftCreatedAt) &&
    Number.isFinite(rightCreatedAt) &&
    leftCreatedAt !== rightCreatedAt
  ) {
    return rightCreatedAt - leftCreatedAt;
  }
  return left.id.localeCompare(right.id);
}

export function inboxUnreadCount(notifications: AppNotification[]): number {
  return inboxNotifications(notifications).reduce(
    (count, notification) => count + (notification.readAt ? 0 : 1),
    0,
  );
}

/** Where activating an inbox row lands; see `notificationTarget`. */
export type NotificationTarget = "session" | "scheduled";

/**
 * A scheduled-task run owns its transcript and the session list never lists it
 * (`isAutomationSession`), so its row must go to the Scheduled page — that
 * task's run history reads the transcript in place. Every other row keeps the
 * ordinary session activation.
 */
export function notificationTarget(
  notification: Pick<AppNotification, "sessionId">,
  sessions: readonly Pick<SessionSummary, "id" | "scheduledRun">[],
): NotificationTarget {
  const session = sessions.find(
    (candidate) => candidate.id === notification.sessionId,
  );
  return isAutomationSession(session) ? "scheduled" : "session";
}
