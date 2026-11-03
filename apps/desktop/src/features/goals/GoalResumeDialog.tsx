import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GoalBudget, SessionGoal } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { GoalBudgetFields } from "./GoalBudgetFields";
import { budgetAllowsResume, budgetToDraft, parseGoalBudget } from "./goal-budget";
import { GoalDialog } from "./GoalDialog";

export function GoalResumeDialog({ goal, pending, error, onResume, onReload, onClose, returnFocus }: {
  goal: SessionGoal; pending: boolean; error?: string | null;
  onResume: (budget: GoalBudget) => void; onReload?: () => void;
  onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => budgetToDraft(goal.budget));
  const budget = parseGoalBudget(draft);
  const sufficient = budget && budgetAllowsResume(budget, goal.roundsStarted, goal.tokenUsage);
  const stopped = !goal.activeTurnId && ["paused", "blocked", "budget_exhausted"].includes(goal.status);
  return <GoalDialog title={t("autonomousGoal.adjustResume")} testId="goal-resume-dialog" closeLabel={t("autonomousGoal.dismiss")} onClose={onClose} returnFocus={returnFocus}>
    <p>{t("autonomousGoal.usedBudget", { turns: goal.roundsStarted, tokens: goal.tokenUsage.toLocaleString() })}</p>
    <p className="goal-hint">{t("autonomousGoal.totalBudgetHint")}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (budget && sufficient && stopped && !pending) onResume(budget); }}>
      <GoalBudgetFields value={draft} onChange={setDraft} disabled={pending || !stopped} />
      {!stopped ? <p className="goal-hint" role="status">{t("autonomousGoal.pauseFirst")}</p> : null}
      {error ? <div className="goal-error" role="alert"><p>{t("autonomousGoal.controlError", { message: error })}</p>
        {onReload ? <Button type="button" size="sm" disabled={pending} onClick={onReload}>{t("autonomousGoal.reload")}</Button> : null}
      </div> : null}
      <div className="goal-dialog-actions"><Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("autonomousGoal.dismiss")}</Button>
        <Button type="submit" size="sm" variant="primary" disabled={pending || !sufficient || !stopped}>
          {t(pending ? "autonomousGoal.resuming" : "autonomousGoal.adjustResume")}
        </Button>
      </div>
    </form>
  </GoalDialog>;
}
