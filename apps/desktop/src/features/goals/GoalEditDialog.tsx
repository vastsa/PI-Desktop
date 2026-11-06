import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionGoal } from "@pi-desktop/shared";
import { Button, Textarea } from "../../components/ui";
import { GoalDialog } from "./GoalDialog";

export function GoalEditDialog({ goal, pending, error, onSave, onReload, onClose, returnFocus }: {
  goal: SessionGoal; pending: boolean; error?: string | null;
  onSave: (objective: string) => void; onReload?: () => void;
  onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const [draft, setDraft] = useState(goal.objective);
  const editable = !["completed", "cancelled"].includes(goal.status);
  return <GoalDialog title={t("autonomousGoal.edit")} testId="goal-edit-dialog" closeLabel={t("autonomousGoal.dismiss")} onClose={onClose} returnFocus={returnFocus}>
    <form onSubmit={(event) => { event.preventDefault(); if (editable && draft.trim() && !pending) onSave(draft.trim()); }}>
      <label className="goal-edit-field"><span>{t("autonomousGoal.editObjective")}</span>
        <Textarea rows={5} aria-label={t("autonomousGoal.editObjective")} aria-describedby={hintId} value={draft}
          disabled={!editable || pending} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <p id={hintId} className="goal-hint">{t("autonomousGoal.editHint")}</p>
      {error ? <div className="goal-error" role="alert"><p>{t("autonomousGoal.controlError", { message: error })}</p>
        {onReload ? <Button type="button" size="sm" disabled={pending} onClick={onReload}>{t("autonomousGoal.reload")}</Button> : null}
      </div> : null}
      <div className="goal-dialog-actions"><Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("autonomousGoal.dismiss")}</Button>
        <Button type="submit" size="sm" variant="primary" disabled={!editable || pending || !draft.trim()}>{t(pending ? "autonomousGoal.saving" : "autonomousGoal.saveEdit")}</Button>
      </div>
    </form>
  </GoalDialog>;
}
