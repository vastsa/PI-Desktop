import { Notification as SystemNotification } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import {
  shouldShowNativeNotification,
} from "../notification-policy";
import type { IpcRegistrar } from "./types";

export type NotificationIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getMainWindow: () => Electron.BrowserWindow | null;
  getViewingSessionId: () => string | null;
  setViewingSessionId: (sessionId: string | null) => void;
  sendToRenderer: (channel: string, payload: unknown) => void;
};

// Windows delivers Action Center activation through the native notification
// presenter, which can only find notifications that are still strongly
// referenced by the main process. Keep task notifications indexed by their
// durable id until the user acknowledges them. The id also makes delivery
// idempotent when a late/replayed renderer event arrives for the same row.
type TaskNativeNotificationEntry = {
  notification: SystemNotification;
  dismissed: boolean;
};

const taskNativeNotifications = new Map<string, TaskNativeNotificationEntry>();
const dismissedTaskNotificationIds = new Set<string>();
// A clear/mark-all acknowledgement dismisses every task row that existed at
// that point. Renderer events carry the durable creation timestamp so Main can
// reject a delayed pre-ack replay even when its native object was never shown.
let dismissedBefore = 0;
// Interactive prompts do not have durable ids or read/clear actions, but they
// still need a strong reference until Electron reports their native lifecycle.
const interactiveNativeNotifications = new Set<SystemNotification>();
const MAX_DISMISSED_TASK_NOTIFICATION_IDS = 512;

function rememberDismissedTaskNotification(id: string): void {
  dismissedTaskNotificationIds.delete(id);
  dismissedTaskNotificationIds.add(id);
  while (dismissedTaskNotificationIds.size > MAX_DISMISSED_TASK_NOTIFICATION_IDS) {
    const oldest = dismissedTaskNotificationIds.values().next().value;
    if (typeof oldest !== "string") break;
    dismissedTaskNotificationIds.delete(oldest);
  }
}

function dismissTaskNativeNotification(id: string): void {
  if (!id) return;
  const entry = taskNativeNotifications.get(id);
  taskNativeNotifications.delete(id);
  rememberDismissedTaskNotification(id);
  if (entry) {
    entry.dismissed = true;
    try {
      entry.notification.close();
    } catch {
      // Native notification teardown is best-effort; the durable row is
      // already acknowledged by the host.
    }
  }
}

function dismissAllTaskNativeNotifications(): void {
  for (const id of [...taskNativeNotifications.keys()]) {
    dismissTaskNativeNotification(id);
  }
}

function releaseTaskNativeNotification(
  id: string,
  notification: SystemNotification,
  retainId: boolean,
): void {
  const entry = taskNativeNotifications.get(id);
  if (!entry || entry.notification !== notification) return;
  taskNativeNotifications.delete(id);
  if (retainId || entry.dismissed) rememberDismissedTaskNotification(id);
}

/** Register durable notification queries and native notification actions. */
export function registerNotificationIpc({
  registrar,
  getHost,
  getMainWindow,
  getViewingSessionId,
  setViewingSessionId,
  sendToRenderer,
}: NotificationIpcDependencies): void {
  const { handle } = registrar;

  handle(
    IPC.invoke.notificationList,
    async (input: { unreadOnly?: boolean; limit?: number } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return host.call("notification.list", input);
    },
  );

  handle(IPC.invoke.notificationMarkRead, async (input: { id?: string } = {}) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const result = await host.call("notification.markRead", input);
    if (id && result?.ok !== false) dismissTaskNativeNotification(id);
    return result;
  });

  handle(IPC.invoke.notificationMarkAllRead, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call("notification.markAllRead");
    dismissedBefore = Math.max(dismissedBefore, Date.now());
    dismissAllTaskNativeNotifications();
    return result;
  });

  handle(IPC.invoke.notificationClear, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call("notification.clear");
    dismissedBefore = Math.max(dismissedBefore, Date.now());
    dismissAllTaskNativeNotifications();
    return result;
  });

  handle(
    IPC.invoke.notificationSetViewingSession,
    async (input: { sessionId?: unknown } = {}) => {
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : "";
      setViewingSessionId(sessionId || null);
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.notificationShowNative,
    async (input: {
      id?: string;
      sessionId?: string;
      kind?: "task" | "interactive";
      title?: string;
      body?: string;
      createdAt?: string;
    } = {}) => {
      const mainWindow = getMainWindow();
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        !SystemNotification.isSupported()
      ) {
        return { shown: false };
      }
      const id = String(input.id ?? "");
      const sessionId = String(input.sessionId ?? "");
      const kind = input.kind === "interactive" ? "interactive" : "task";
      const title = String(input.title ?? "").trim().slice(0, 100);
      const body = String(input.body ?? "").trim().slice(0, 240);
      const createdAt =
        typeof input.createdAt === "string" ? Date.parse(input.createdAt) : NaN;
      if (!id || !sessionId || !title) return { shown: false };

      if (
        kind === "task" &&
        Number.isFinite(createdAt) &&
        createdAt <= dismissedBefore
      ) {
        return { shown: false };
      }

      const liveWindow = !mainWindow.isDestroyed();
      const windowVisible = liveWindow && mainWindow.isVisible() === true;
      const windowFocused = liveWindow && mainWindow.isFocused() === true;
      if (
        !shouldShowNativeNotification({
          kind,
          sessionId,
          viewingSessionId: getViewingSessionId(),
          windowVisible,
          windowFocused,
        })
      ) {
        return { shown: false };
      }

      const existingTaskNotification =
        kind === "task" ? taskNativeNotifications.get(id) : undefined;
      if (
        kind === "task" &&
        (existingTaskNotification?.dismissed === true ||
          existingTaskNotification !== undefined ||
          dismissedTaskNotificationIds.has(id))
      ) {
        // A durable row is exactly-once. Replayed IPC events must not create a
        // second Windows toast after the first one has moved to Action Center.
        return { shown: false };
      }

      const notification = new SystemNotification({ title, body });
      if (kind === "task") {
        taskNativeNotifications.set(id, { notification, dismissed: false });
      } else {
        interactiveNativeNotifications.add(notification);
      }
      const releaseNotification = (retainId: boolean) => {
        if (kind === "task") {
          releaseTaskNativeNotification(id, notification, retainId);
        } else {
          interactiveNativeNotifications.delete(notification);
        }
      };
      notification.once("close", () => releaseNotification(true));
      notification.once("failed", () => releaseNotification(false));
      notification.once("click", () => {
        const window = getMainWindow();
        try {
          if (!window || window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          sendToRenderer(IPC.event.notificationActivated, { id, sessionId });
        } finally {
          releaseNotification(true);
        }
      });
      try {
        notification.show();
      } catch {
        releaseNotification(false);
      }
      return { shown: true };
    },
  );
}
