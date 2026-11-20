import type { AppNotification, AskToolRequest, SessionSummary } from "@pi-desktop/shared";
import { normalizeProjectPath, type ProjectMeta } from "./sidebar-preferences.ts";

/**
 * Failure-row projection for the bell. Unread completed outcomes render in the
 * attention section from the same bounded notification history. The shared
 * durable unread total already includes both kinds.
 */
export function inboxNotifications(
  notifications: AppNotification[],
): AppNotification[] {
  return notifications.filter(
    (notification) => notification.kind !== "task.completed",
  );
}

export function inboxUnreadCount(notifications: AppNotification[]): number {
  return inboxNotifications(notifications).reduce(
    (count, notification) => count + (notification.readAt ? 0 : 1),
    0,
  );
}

/** The durable unread total already includes both completion and failure rows. */
export function notificationBadgeCount(
  taskUnreadCount: number, interactiveCount: number,
): number {
  return taskUnreadCount + interactiveCount;
}

/** Draft answers and notification read markers never settle an open ask. */
export function questionInboxItems(queues: Record<string, AskToolRequest[]>): AskToolRequest[] {
  return Object.values(queues).flat();
}

export function notificationSessionLabel(
  sessionId: string,
  sessions: Pick<SessionSummary, "id" | "title" | "projectPath">[],
  projectMeta: Record<string, ProjectMeta>,
  fallbackTitle = "",
): { sessionTitle: string; projectName: string | undefined } {
  const session = sessions.find((item) => item.id === sessionId);
  const path = normalizeProjectPath(session?.projectPath);
  const projectName = path
    ? projectMeta[path]?.name?.trim() || projectMeta[session?.projectPath ?? ""]?.name?.trim()
      || path.split("/").filter(Boolean).at(-1) || path
    : undefined;
  const sessionTitle = [session?.title, fallbackTitle].map((title) => title?.trim()).find((title) =>
    title && title !== sessionId && !/^[a-f\d]{32}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(title));
  return { sessionTitle: sessionTitle || "", projectName };
}

export function formatNotificationSessionLabel(
  label: ReturnType<typeof notificationSessionLabel>, sessionsLabel: string, untitledLabel: string,
): string {
  return `${label.projectName || sessionsLabel} · ${label.sessionTitle || untitledLabel}`;
}
