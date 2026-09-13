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
// referenced by the main process. Keep task notifications alive until their
// native lifecycle ends instead of letting the IPC handler's local reference
// disappear as soon as it returns.
const taskNativeNotifications = new Set<SystemNotification>();

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
    return host.call("notification.markRead", input);
  });

  handle(IPC.invoke.notificationMarkAllRead, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("notification.markAllRead");
  });

  handle(IPC.invoke.notificationClear, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("notification.clear");
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
      if (!id || !sessionId || !title) return { shown: false };

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

      const notification = new SystemNotification({ title, body });
      taskNativeNotifications.add(notification);
      const releaseNotification = () => taskNativeNotifications.delete(notification);
      notification.once("close", releaseNotification);
      notification.once("failed", releaseNotification);
      notification.once("click", () => {
        const window = getMainWindow();
        try {
          if (!window || window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          sendToRenderer(IPC.event.notificationActivated, { id, sessionId });
        } finally {
          releaseNotification();
        }
      });
      try {
        notification.show();
      } catch {
        releaseNotification();
      }
      return { shown: true };
    },
  );
}
