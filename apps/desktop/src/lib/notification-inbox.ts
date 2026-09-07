import type { AppNotification } from "@pi-desktop/shared";

/**
 * The inbox popover surfaces only outcomes that need attention. Successful
 * completions stay in the durable record so the sidebar outcome badge and the
 * native system notification keep working, but listing every one of them
 * buried the failures under noise.
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
