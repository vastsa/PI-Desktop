import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GoalBudget, SessionGoal } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { GoalBudgetFields } from "./GoalBudgetFields";
import { budgetToDraft, parseGoalBudget } from "./goal-budget";
import { GoalDialog } from "./GoalDialog";

/** Editing this goal's total limits never resumes it or changes defaults. */
export function GoalBudgetDialog({ goal, pending, error, onSave, onClose, returnFocus }: {
  goal: SessionGoal; pending: boolean; error?: string | null;
  onSave: (budget: GoalBudget) => void; onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => budgetToDraft(goal.pendingBudget ?? goal.budget));
  return <GoalDialog title={t("autonomousGoal.editBudget")} testId="goal-budget-dialog" closeLabel={t("autonomousGoal.dismiss")} onClose={onClose} returnFocus={returnFocus}>
    <p>{t("autonomousGoal.usedBudget", { turns: goal.roundsStarted, tokens: goal.tokenUsage.toLocaleString() })}</p>
    <p className="goal-hint">{t("autonomousGoal.budgetEditHint")}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!pending) onSave(parseGoalBudget(draft)); }}>
      <GoalBudgetFields value={draft} onChange={setDraft} disabled={pending} />
      {error ? <p className="goal-error" role="alert">{t("autonomousGoal.controlError", { message: error })}</p> : null}
      <div className="goal-dialog-actions">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("autonomousGoal.dismiss")}</Button>
        <Button type="submit" size="sm" variant="primary" disabled={pending}>{t("autonomousGoal.saveEdit")}</Button>
      </div>
    </form>
  </GoalDialog>;
}
