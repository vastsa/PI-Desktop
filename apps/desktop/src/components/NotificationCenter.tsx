import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AppNotification } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import {
  inboxNotifications,
  inboxUnreadCount,
} from "../lib/notification-inbox";
import {
  IconBell,
  IconCheckCheck,
  IconCircleAlert,
  IconCircleCheck,
  IconTrash,
} from "./icons";

type NotificationFilter = "all" | "unread";

function formatRelativeTime(value: string, locale: string, justNow: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return justNow;

  const delta = timestamp - Date.now();
  const absoluteDelta = Math.abs(delta);
  if (absoluteDelta < 45_000) return justNow;

  try {
    const formatter = new Intl.RelativeTimeFormat(locale || undefined, {
      numeric: "auto",
    });
    if (absoluteDelta < 60 * 60_000) {
      return formatter.format(Math.round(delta / 60_000), "minute");
    }
    if (absoluteDelta < 24 * 60 * 60_000) {
      return formatter.format(Math.round(delta / (60 * 60_000)), "hour");
    }
    if (absoluteDelta < 7 * 24 * 60 * 60_000) {
      return formatter.format(Math.round(delta / (24 * 60 * 60_000)), "day");
    }
    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
      year:
        new Date(timestamp).getFullYear() === new Date().getFullYear()
          ? undefined
          : "numeric",
    }).format(timestamp);
  } catch {
    return justNow;
  }
}

export function NotificationCenter({
  onBeforeOpen,
}: {
  onBeforeOpen?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const storedNotifications = useAppStore((state) => state.notifications);
  // Successful completions are hidden here; they still drive the sidebar
  // outcome badge and native notifications from the unfiltered store.
  const notifications = useMemo(
    () => inboxNotifications(storedNotifications),
    [storedNotifications],
  );
  const unreadCount = useMemo(
    () => inboxUnreadCount(storedNotifications),
    [storedNotifications],
  );
  const refreshNotifications = useAppStore((state) => state.refreshNotifications);
  const markAllNotificationsRead = useAppStore(
    (state) => state.markAllNotificationsRead,
  );
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const openNotification = useAppStore((state) => state.openNotification);
  const showToast = useAppStore((state) => state.showToast);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const visibleNotifications = useMemo(
    () =>
      filter === "unread"
        ? notifications.filter((notification) => !notification.readAt)
        : notifications,
    [filter, notifications],
  );

  const closePopover = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      setPopoverPos({
        bottom: Math.max(12, window.innerHeight - rect.top + 8),
        left,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    void refreshNotifications()
      .catch(() =>
        showToast(t("notifications.actionFailed"), { variant: "error" }),
      )
      .finally(() => {
        setBusy(false);
        requestAnimationFrame(() => {
          popoverRef.current
            ?.querySelector<HTMLButtonElement>(
              ".notification-item.unread, .notification-item, .notification-filter.active",
            )
            ?.focus();
        });
      });
  }, [open, refreshNotifications, showToast, t]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      closePopover(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopover();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePopover, open]);

  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".notification-item:not(:disabled)",
      ),
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowUp") {
      next = Math.max(0, current < 0 ? 0 : current - 1);
    } else if (event.key === "ArrowDown") {
      next = Math.min(buttons.length - 1, current < 0 ? 0 : current + 1);
    }
    buttons[next]?.focus();
  };

  const focusActiveFilter = () => {
    requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(".notification-filter.active")
        ?.focus();
    });
  };

  const runToolbarAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      focusActiveFilter();
    } catch {
      showToast(t("notifications.actionFailed"), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const activateNotification = async (notification: AppNotification) => {
    closePopover();
    try {
      await openNotification(notification.id);
    } catch {
      showToast(t("notifications.actionFailed"), { variant: "error" });
    }
  };

  const unreadLabel =
    unreadCount > 0
      ? t("notifications.openUnread", { count: unreadCount })
      : t("notifications.open");
  const emptyUnread = filter === "unread";

  return (
    <div className="notification-center" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`footer-notification notification-trigger ${open ? "active" : ""}`}
        aria-label={unreadLabel}
        title={unreadLabel}
        aria-haspopup="dialog"
        aria-controls="notification-popover"
        aria-expanded={open}
        onClick={() => {
          if (open) closePopover();
          else {
            onBeforeOpen?.();
            setOpen(true);
          }
        }}
      >
        <IconBell size={14} aria-hidden />
        {unreadCount > 0 ? (
          <span className="notification-badge" aria-hidden>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {unreadLabel}
      </span>

      {open && popoverPos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              id="notification-popover"
              className="notification-popover notification-popover-portaled"
              role="dialog"
              aria-labelledby="notification-title"
              onKeyDown={onPopoverKeyDown}
              style={{ bottom: popoverPos.bottom, left: popoverPos.left }}
            >
          <header className="notification-header">
            <h2 id="notification-title">{t("notifications.title")}</h2>
            <div className="notification-actions">
              <button
                type="button"
                className="notification-action"
                aria-label={t("notifications.markAllRead")}
                title={t("notifications.markAllRead")}
                disabled={busy || unreadCount === 0}
                onClick={() => void runToolbarAction(markAllNotificationsRead)}
              >
                <IconCheckCheck size={15} aria-hidden />
              </button>
              <button
                type="button"
                className="notification-action"
                aria-label={t("notifications.clearAll")}
                title={t("notifications.clearAll")}
                disabled={busy || notifications.length === 0}
                onClick={() => void runToolbarAction(clearNotifications)}
              >
                <IconTrash size={15} aria-hidden />
              </button>
            </div>
          </header>

          <div
            className="notification-filters"
            role="group"
            aria-label={t("notifications.title")}
          >
            {(["all", "unread"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`notification-filter ${filter === value ? "active" : ""}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(`notifications.${value}`)}
              </button>
            ))}
          </div>

          {visibleNotifications.length > 0 ? (
            <ul className="notification-list">
              {visibleNotifications.map((notification) => {
                const failed = notification.kind === "task.failed";
                const sessionTitle = notification.sessionTitle || t("chat.untitledTask");
                const title = t(
                  failed
                    ? "notifications.failedTitle"
                    : "notifications.completedTitle",
                  { sessionTitle },
                );
                const body = failed
                  ? notification.errorCode
                    ? t("notifications.failedBodyWithCode", {
                        code: notification.errorCode,
                      })
                    : t("notifications.failedBody")
                  : t("notifications.completedBody");
                return (
                  <li key={notification.id}>
                    <button
                      type="button"
                      className={`notification-item ${notification.readAt ? "" : "unread"}`}
                      data-notification-id={notification.id}
                      disabled={busy}
                      onClick={() => void activateNotification(notification)}
                    >
                      <span
                        className={`notification-kind-icon ${failed ? "failed" : ""}`}
                        aria-hidden
                      >
                        {failed ? (
                          <IconCircleAlert size={17} />
                        ) : (
                          <IconCircleCheck size={17} />
                        )}
                      </span>
                      <span className="notification-copy">
                        <span className="notification-item-title">{title}</span>
                        <span className="notification-item-body">{body}</span>
                      </span>
                      <time
                        className="notification-time"
                        dateTime={notification.createdAt}
                      >
                        {formatRelativeTime(
                          notification.createdAt,
                          i18n.resolvedLanguage || i18n.language,
                          t("notifications.justNow"),
                        )}
                      </time>
                      {!notification.readAt ? (
                        <span className="notification-unread-dot" aria-hidden />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="notification-empty" role="status">
              <IconBell size={22} aria-hidden />
              <strong>
                {t(
                  emptyUnread
                    ? "notifications.emptyUnreadTitle"
                    : "notifications.emptyTitle",
                )}
              </strong>
              <span>
                {t(
                  emptyUnread
                    ? "notifications.emptyUnreadBody"
                    : "notifications.emptyBody",
                )}
              </span>
            </div>
          )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
