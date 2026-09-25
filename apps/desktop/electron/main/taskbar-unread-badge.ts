import { app, nativeImage, type BrowserWindow } from "electron";
import {
  IPC,
  type NotificationListResult,
} from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";
import {
  TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR,
  buildTaskbarUnreadOverlayPng,
  formatTaskbarUnreadOverlayLabel,
  renderTaskbarUnreadOverlayPng,
} from "./taskbar-unread-overlay";

const REFRESH_AFTER_INVOKE = new Set<string>([
  IPC.invoke.notificationMarkRead,
  IPC.invoke.notificationMarkAllRead,
  IPC.invoke.notificationClear,
]);

/**
 * Main-owned shell badge for unread durable task notifications.
 * Uses host unreadCount (completed + failed). Does not change D295 bell filtering.
 *
 * `desiredCount` is what we last learned from the host; `appliedCount` is what we
 * successfully painted onto the OS shell. Windows overlay needs a live BrowserWindow,
 * so a host update that arrives before the window exists must not mark the count as
 * applied — otherwise a later refresh with the same count early-returns and the
 * overlay never appears.
 *
 * On win32, painting prefers a smooth renderer Canvas PNG. The deterministic
 * main-process bitmap remains a fallback before the renderer is ready. Both
 * paths are 64×64 + scaleFactor 3 → ~21×21 logical, with no intermediate resize.
 */
export function createTaskbarUnreadBadge({
  getHost,
  getMainWindow,
  isQuitting,
  logger,
}: {
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  isQuitting: () => boolean;
  logger: Pick<Logger, "app">;
}) {
  let revision = 0;
  let pending: Promise<void> | null = null;
  let desiredCount: number | null = null;
  let appliedCount: number | null = null;
  /** Bumped on every win32 paint attempt; stale async paints must no-op. */
  let paintRevision = 0;

  function apply(count: number, options?: { force?: boolean }): Promise<void> {
    const next = Math.max(0, Math.floor(count));
    desiredCount = next;
    if (!options?.force && appliedCount === next) return Promise.resolve();

    if (process.platform === "win32") {
      return paintWin32(next);
    }

    try {
      app.setBadgeCount(next);
      appliedCount = next;
    } catch (error) {
      logger.app("diagnostics", "warn", "shell badge count update failed", {
        data: String(error),
      });
    }
    return Promise.resolve();
  }

  async function paintWin32(next: number): Promise<void> {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      // Remember desiredCount but do not advance appliedCount.
      return;
    }

    const myRevision = ++paintRevision;
    try {
      if (next <= 0) {
        if (myRevision !== paintRevision) return;
        if (window.isDestroyed()) return;
        window.setOverlayIcon(null, "");
        appliedCount = next;
        return;
      }

      const label = formatTaskbarUnreadOverlayLabel(next);
      if (!label) {
        if (myRevision !== paintRevision) return;
        if (window.isDestroyed()) return;
        window.setOverlayIcon(null, "");
        appliedCount = 0;
        return;
      }

      let png: Buffer | null = null;
      const contents = window.webContents;
      if (contents && !contents.isDestroyed()) {
        try {
          png = await renderTaskbarUnreadOverlayPng(contents, next);
        } catch (error) {
          logger.app(
            "diagnostics",
            "warn",
            "taskbar overlay canvas render failed; using bitmap fallback",
            { data: String(error) },
          );
        }
      }
      if (!png) png = buildTaskbarUnreadOverlayPng(next);

      if (myRevision !== paintRevision) return;
      if (window.isDestroyed()) return;

      if (!png) {
        window.setOverlayIcon(null, "");
        appliedCount = 0;
        return;
      }

      // 64×64 raster + scaleFactor 3 → ~21×21 logical DIP for a readable badge.
      let image = nativeImage.createFromBuffer(png, {
        scaleFactor: TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR,
      });
      if (image.isEmpty() && typeof nativeImage.createFromDataURL === "function") {
        image = nativeImage.createFromDataURL(
          `data:image/png;base64,${png.toString("base64")}`,
        );
      }
      if (image.isEmpty()) {
        window.setOverlayIcon(null, "");
        appliedCount = 0;
        return;
      }
      // The 64px source is already sized for the Windows overlay slot.
      window.setOverlayIcon(image, label);
      appliedCount = next;
    } catch (error) {
      if (myRevision !== paintRevision) return;
      logger.app("diagnostics", "warn", "taskbar overlay icon update failed", {
        data: String(error),
      });
    }
  }

  function refresh(): Promise<void> {
    revision += 1;
    if (pending) return pending;
    pending = (async () => {
      let observed: number;
      do {
        observed = revision;
        const host = getHost();
        if (!host || isQuitting()) {
          await apply(0);
          return;
        }
        try {
          const inbox = await host.call<NotificationListResult>(
            "notification.list",
            { limit: 1 },
          );
          if (isQuitting()) return;
          if (host !== getHost()) {
            revision += 1;
            continue;
          }
          if (observed !== revision) continue;
          await apply(inbox.unreadCount ?? 0);
        } catch (error) {
          if (host !== getHost()) {
            revision += 1;
            continue;
          }
          if (observed !== revision || isQuitting()) continue;
          logger.app("diagnostics", "warn", "taskbar unread badge refresh failed", {
            data: String(error),
          });
        }
      } while (observed !== revision);
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  /** Re-paint the last desired count (e.g. main window / tray just became ready). */
  function replay(): void {
    if (desiredCount === null) {
      void refresh();
      return;
    }
    void apply(desiredCount, { force: true });
  }

  return {
    refresh,
    replay,
    observeEvent(channel: string, _payload?: unknown) {
      if (isQuitting()) return;
      if (
        channel === IPC.event.notificationChanged ||
        channel === IPC.event.hostStatus
      ) {
        void refresh();
      }
    },
    observeInvoke(channel: string) {
      if (REFRESH_AFTER_INVOKE.has(channel)) void refresh();
    },
  };
}
