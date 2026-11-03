import { useTranslation } from "react-i18next";
import type { SessionGoal } from "@pi-desktop/shared";
import { Badge, Button } from "../../components/ui";
import { GoalDialog } from "./GoalDialog";

export function GoalDetailsDialog({ goal, onClose, returnFocus, onAdjustResume, onAdjustBudget }: {
  goal: SessionGoal; onClose: () => void; returnFocus: HTMLElement | null; onAdjustResume?: () => void; onAdjustBudget?: () => void;
}) {
  const { t } = useTranslation();
  const criteria = [...new Set([...goal.criteria, ...goal.outcomes.map((item) => item.criterion)])];
  const unlimited = t("autonomousGoal.unlimited");
  return <GoalDialog title={t("autonomousGoal.details")} testId="goal-details-dialog" onClose={onClose} returnFocus={returnFocus}>
    <h3>{t("autonomousGoal.objective")}</h3>
    <p className="selectable">{goal.objective}</p>
    <dl className="goal-detail-metrics">
      <dt>{t("autonomousGoal.state")}</dt><dd>{t(`autonomousGoal.status.${goal.status}`)}</dd>
      <dt>{t("autonomousGoal.reason")}</dt><dd>{goal.stopReason || t("autonomousGoal.noStopReason")}</dd>
      <dt>{t("autonomousGoal.turnLimit")}</dt><dd>{t("autonomousGoal.turns", { used: goal.roundsStarted, max: goal.budget.maxTurns ?? unlimited })}</dd>
      <dt>{t("autonomousGoal.tokenLimit")}</dt><dd>{t("autonomousGoal.tokensLimited", { used: goal.tokenUsage.toLocaleString(), max: goal.budget.maxTokens?.toLocaleString() ?? unlimited })}</dd>
    </dl>
    {goal.pendingBudget ? <p className="goal-hint" role="status">{t("autonomousGoal.pendingBudget", { turns: goal.pendingBudget.maxTurns ?? unlimited, tokens: goal.pendingBudget.maxTokens ?? unlimited })}</p> : null}
    {onAdjustBudget ? <Button size="sm" onClick={onAdjustBudget}>{t("autonomousGoal.editBudget")}</Button> : null}
    {goal.activeTurnId ? <p className="goal-hint">{t("autonomousGoal.turnRunning")}</p> : null}
    <h3>{t("autonomousGoal.report")}</h3>
    <p className="goal-hint">{t("autonomousGoal.modelReported")}</p>
    <p className="selectable">{goal.progressSummary || t("autonomousGoal.noProgress")}</p>
    {criteria.length ? <ul className="goal-outcomes">{criteria.map((criterion) => {
      const report = goal.outcomes.find((item) => item.criterion === criterion);
      return <li key={criterion}>
        <Badge tone={report?.outcome === "met" ? "success" : report?.outcome === "unmet" ? "warning" : "neutral"}>{t(`autonomousGoal.outcome.${report?.outcome ?? "unverified"}`)}</Badge>
        <div className="selectable"><strong>{criterion}</strong><p>{report?.evidence || t("autonomousGoal.noEvidence")}</p></div>
      </li>;
    })}</ul> : <p className="goal-hint">{t("autonomousGoal.noCriteria")}</p>}
    <h3>{t("autonomousGoal.audit")}</h3>
    {goal.audit ? <>
      <p className="selectable">{goal.audit.objective}</p>
      <ul className="goal-outcomes">{goal.audit.items.map((item, index) => <li key={`${index}:${item.requirement}`}>
        <Badge tone={item.outcome === "met" ? "success" : item.outcome === "unmet" ? "warning" : "neutral"}>{t(`autonomousGoal.outcome.${item.outcome}`)}</Badge>
        <div className="selectable"><strong>{item.requirement}</strong><p>{item.evidence || t("autonomousGoal.noEvidence")}</p></div>
      </li>)}</ul>
      <h3>{t("autonomousGoal.remainingWork")}</h3>
      {goal.audit.remainingWork.length ? <ul className="selectable">{goal.audit.remainingWork.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{t("autonomousGoal.noRemainingWork")}</p>}
    </> : <p className="goal-hint">{t("autonomousGoal.noAudit")}</p>}
    {onAdjustResume ? <div className="goal-dialog-actions"><Button size="sm" onClick={onAdjustResume}>{t("autonomousGoal.adjustResume")}</Button></div> : null}
  </GoalDialog>;
}
