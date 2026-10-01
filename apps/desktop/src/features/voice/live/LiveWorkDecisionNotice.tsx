import type { TFunction } from "i18next";
import { Button } from "../../../components/ui";
import type { LiveWorkDecision } from "./live-work-decision";

/** The question/permission/plan sentence for one pending work decision. */
export function liveWorkDecisionText(decision: LiveWorkDecision, t: TFunction): string {
  if (decision.kind === "ask") {
    const more = decision.additionalQuestions > 0
      ? ` ${t("liveVoice.decisionMoreQuestions", { count: decision.additionalQuestions })}`
      : "";
    return `${t("liveVoice.decisionAsk", { question: decision.question })}${more}`;
  }
  if (decision.kind === "permission") {
    return t("liveVoice.decisionPermission", { toolName: decision.toolName });
  }
  if (decision.kind === "plan" && decision.title) {
    return t("liveVoice.decisionPlan", { title: decision.title });
  }
  return t("liveVoice.decisionWaiting");
}

/**
 * The bound work session is blocked on the user. The card that answers it lives
 * in that session's own Composer, which is a different surface from the call
 * bar and may not even be the session on screen, so this notice states what is
 * being asked and opens the exact session.
 *
 * It never offers approve/answer actions: spoken agreement is not a decision
 * (Live Voice Work Session spec), and the request content is untrusted data.
 */
export function LiveWorkDecisionNotice({
  decision,
  t,
  busy = false,
  onOpen,
}: {
  decision: LiveWorkDecision;
  t: TFunction;
  busy?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="live-voice-decision" role="status">
      <strong className="live-voice-decision-title">{t("liveVoice.decisionTitle")}</strong>
      <p className="live-voice-work-summary">{liveWorkDecisionText(decision, t)}</p>
      <p className="live-voice-hint">{t("liveVoice.decisionHint")}</p>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={onOpen}
      >
        {t("liveVoice.decisionOpen")}
      </Button>
    </div>
  );
}
