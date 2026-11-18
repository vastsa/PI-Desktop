import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { questionInboxItems } from "../../lib/notification-inbox";
import { useAppStore } from "../../stores/app-store";

/** Own the notification-center subscriptions even while its popover is closed. */
export function useNotificationAttention() {
  const { t } = useTranslation();
  const ready = useAppStore((state) => state.ready);
  const queues = useAppStore((state) => state.pendingAsks);
  const permissionQueues = useAppStore((state) => state.pendingPermissions);
  const notifications = useAppStore((state) => state.notifications);
  const completions = useMemo(() => notifications.filter((item) =>
    item.kind === "task.completed" && !item.readAt), [notifications]);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const selecting = useAppStore((state) => state.selectingSessionId);
  const page = useAppStore((state) => state.page);
  const refresh = useAppStore((state) => state.refreshNotificationAttention);
  const acknowledge = useAppStore((state) => state.acknowledgeVisibleCompletions);
  const showToast = useAppStore((state) => state.showToast);
  const dismissed = useAppStore((state) => state.dismissedNotificationRequests);
  const dismiss = useAppStore((state) => state.dismissNotificationRequests);
  const reportError = useCallback(() => {
    showToast(t("notifications.actionFailed"), { variant: "error" });
  }, [showToast, t]);
  const questions = useMemo(() => questionInboxItems(queues)
    .filter((item) => !dismissed[item.requestId]), [queues, dismissed]);
  const permissions = useMemo(() => Object.values(permissionQueues).flat()
    .filter((item) => !dismissed[item.requestId]), [permissionQueues, dismissed]);

  useEffect(() => { dismiss([]); }, [queues, permissionQueues, dismiss]);

  useEffect(() => {
    if (ready) void refresh().catch(reportError);
  }, [ready, refresh, reportError]);

  useEffect(() => {
    if (!ready) return;
    const confirm = () => { void acknowledge().catch(reportError); };
    confirm();
    window.addEventListener("focus", confirm);
    document.addEventListener("visibilitychange", confirm);
    return () => {
      window.removeEventListener("focus", confirm);
      document.removeEventListener("visibilitychange", confirm);
    };
  }, [ready, sessionId, selecting, page, completions, acknowledge, reportError]);

  return { questions, permissions, completions, refresh, dismiss };
}
