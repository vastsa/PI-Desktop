import type { AppNotification, AskToolRequest, ToolPermissionRequest } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { notificationSessionLabel } from "../lib/notification-inbox";
import { useAppStore } from "../stores/app-store";
import { IconCircleCheck, IconHelp, IconShield } from "./icons";
import { Button } from "./ui";

type Props = {
  questions: AskToolRequest[];
  permissions: ToolPermissionRequest[];
  completions: AppNotification[];
  completionCount: number;
  busy: boolean;
  onActivate: (sessionId: string) => void;
  onLoadMore: () => void;
};

export function NotificationAttentionItems({ questions, permissions, completions, completionCount,
  busy, onActivate, onLoadMore }: Props) {
  const { t } = useTranslation();
  const sessions = useAppStore((state) => state.sessions);
  const projectMeta = useAppStore((state) => state.projectMeta);
  const title = (sessionId: string, kind: "question" | "completion" | "approval", fallbackTitle?: string) => {
    const label = notificationSessionLabel(sessionId, sessions, projectMeta, fallbackTitle);
    return t(`notifications.${kind}${label.projectName ? "Project" : "Session"}`, {
      ...label, sessionTitle: label.sessionTitle || t("chat.untitledTask"),
    });
  };
  return <>
    {permissions.map((request) => <li key={`permission:${request.sessionId}:${request.requestId}`}>
      <Button variant="ghost" className="notification-item unread notification-permission"
        data-permission-id={request.requestId} disabled={busy}
        onClick={() => onActivate(request.sessionId)}>
        <span className="notification-kind-icon" aria-hidden><IconShield size={17} /></span>
        <span className="notification-copy">
          <span className="notification-item-title">{title(request.sessionId, "approval")}</span>
          <span className="notification-item-body">
            {t("notifications.permissionBody", { toolName: request.toolName })}
          </span>
        </span>
      </Button>
    </li>)}
    {questions.map((request) => <li key={`ask:${request.sessionId}:${request.requestId}`}>
      <Button variant="ghost" className="notification-item unread notification-question"
        data-request-id={request.requestId} disabled={busy}
        onClick={() => onActivate(request.sessionId)}>
        <span className="notification-kind-icon" aria-hidden><IconHelp size={17} /></span>
        <span className="notification-copy">
          <span className="notification-item-title">{title(request.sessionId, "question")}</span>
          <span className="notification-item-body">{request.questions[0]?.question}</span>
        </span>
      </Button>
    </li>)}
    {completions.map((notification) => <li key={`completion:${notification.id}`}>
      <Button variant="ghost" className="notification-item unread notification-completion"
        data-completion-id={notification.id} disabled={busy}
        onClick={() => onActivate(notification.sessionId)}>
        <span className="notification-kind-icon" aria-hidden><IconCircleCheck size={17} /></span>
        <span className="notification-copy">
          <span className="notification-item-title">
            {title(notification.sessionId, "completion", notification.sessionTitle)}
          </span>
          <span className="notification-item-body">{t("notifications.completedBody")}</span>
        </span>
      </Button>
    </li>)}
    {completions.length < completionCount ? <li>
      <Button variant="ghost" disabled={busy} onClick={onLoadMore}>
        {t("notifications.loadMoreCompletions")}
      </Button>
    </li> : null}
  </>;
}
