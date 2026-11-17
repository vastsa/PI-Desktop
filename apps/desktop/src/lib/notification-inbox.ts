import type { AppNotification, AskToolRequest, SessionSummary } from "@pi-desktop/shared";
import { normalizeProjectPath, type ProjectMeta } from "./sidebar-preferences.ts";

/**
 * The inbox popover surfaces only outcomes that need attention (D295). Successful
 * completions stay in the durable record so the sidebar outcome badge and the
 * native system notification keep working, but listing every one of them
 * buried the failures under noise. The OS shell/taskbar unread overlay is
 * separate and counts all unread task notifications (completed + failed).
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

/** Completion attention mirrors task history, so count the larger task projection. */
export function notificationBadgeCount(
  taskUnreadCount: number, inboxCount: number, completionCount: number, interactiveCount: number,
): number {
  return Math.max(taskUnreadCount, inboxCount + completionCount) + interactiveCount;
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
