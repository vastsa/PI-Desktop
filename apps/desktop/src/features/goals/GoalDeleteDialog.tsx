import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { GoalDialog } from "./GoalDialog";

export function GoalDeleteDialog({ pending, error, onDelete, onReload, onClose, returnFocus }: {
  pending: boolean; error?: string | null; onDelete: () => void; onReload?: () => void;
  onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const { t } = useTranslation();
  return <GoalDialog title={t("autonomousGoal.delete")} testId="goal-delete-dialog" hideHeaderClose onClose={onClose} returnFocus={returnFocus}>
    <p>{t("autonomousGoal.deleteHint")}</p>
    {error ? <div className="goal-error" role="alert"><p>{t("autonomousGoal.controlError", { message: error })}</p>
      {onReload ? <Button size="sm" disabled={pending} onClick={onReload}>{t("autonomousGoal.reload")}</Button> : null}
    </div> : null}
    <div className="goal-dialog-actions"><Button size="sm" variant="ghost" onClick={onClose}>{t("autonomousGoal.dismiss")}</Button>
      <Button size="sm" variant="primary" disabled={pending} onClick={onDelete}>{t(pending ? "autonomousGoal.deleting" : "autonomousGoal.confirmDelete")}</Button>
    </div>
  </GoalDialog>;
}
