import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import type { AgentTurnResult } from "../stores/app-store";
import { useAppStore } from "../stores/app-store";
import { IconCircleAlert } from "./icons";

type TurnOutcomeCardProps = {
  messages: UiMessage[];
  result?: AgentTurnResult;
};

function latestTurnMessages(messages: UiMessage[]) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex < 0 ? messages : messages.slice(lastUserIndex + 1);
}

export function TurnOutcomeCard({
  messages,
  result,
}: TurnOutcomeCardProps) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((state) => state.sendPrompt);

  if (!result || result.status === "completed") return null;

  const tail = latestTurnMessages(messages);
  const toolCount = tail.filter((message) => message.role === "tool").length;
  const hasVisibleTurn = tail.some(
    (message) =>
      Boolean(message.content.trim()) ||
      message.role === "tool" ||
      Boolean(message.error),
  );

  if (!hasVisibleTurn) return null;

  return (
    <section
      className="turn-outcome-card failed"
      data-testid="turn-outcome-card"
      data-outcome="failed"
      role="status"
      aria-live="polite"
    >
      <div className="turn-outcome-heading">
        <span className="turn-outcome-icon" aria-hidden>
          <IconCircleAlert size={16} />
        </span>
        <div className="turn-outcome-copy">
          <strong>{t("chat.resultNeedsAttention")}</strong>
          <span>{t("chat.resultFailedBody")}</span>
        </div>
      </div>
      {toolCount > 0 ? (
        <div className="turn-outcome-stats">
          <span>{t("chat.resultSteps", { count: toolCount })}</span>
        </div>
      ) : null}
      <div className="turn-outcome-actions">
        <button
          type="button"
          className="copy-btn primary"
          onClick={() =>
            void sendPrompt(t("chat.continueUnfinishedTaskPrompt"))
          }
        >
          {t("chat.resultContinue")}
        </button>
      </div>
    </section>
  );
}
