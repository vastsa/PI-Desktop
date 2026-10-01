import i18n from "i18next";
import { api } from "../../lib/api";
import { playNotificationChime } from "../../lib/notification-sound";
import type { StoreGet } from "../slices/types";

export type InteractivePromptNotifier = (
  sessionId: string,
  kind: "ask" | "permission" | "plan",
  payload?: { question?: string; toolName?: string },
) => void;

export function createInteractivePromptNotifier(
  get: StoreGet,
): InteractivePromptNotifier {
  return (sessionId, kind, payload) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    const sessionTitle = session?.title || i18n.t("chat.untitledTask");
    let title = "";
    let body = "";
    if (kind === "ask") {
      // Session titles can contain generated/tool-call text; keep the native
      // banner title stable and let its body carry the actual question.
      title = i18n.t("notifications.askTitle");
      body = payload?.question?.trim() || i18n.t("notifications.askBodyFallback");
    } else if (kind === "permission") {
      title = i18n.t("notifications.permissionTitle", { sessionTitle });
      body = i18n.t("notifications.permissionBody", {
        toolName: payload?.toolName || "tool",
      });
    } else {
      title = i18n.t("notifications.planApprovalTitle", { sessionTitle });
      body = i18n.t("notifications.planApprovalBody");
    }
    playNotificationChime();
    if (kind === "ask") {
      get().showToast(`${title}: ${body}`, {
        variant: "info",
        duration: 8_000,
        sound: false,
      });
    }
    void api
      .showNativeNotification({
        id: crypto.randomUUID(),
        sessionId,
        kind: "interactive",
        title,
        body,
      })
      .catch(() => undefined);
  };
}
