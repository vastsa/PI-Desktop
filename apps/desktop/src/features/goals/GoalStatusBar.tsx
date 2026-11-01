import { useCallback, useEffect, useRef, useState } from "react";
import { CircleEllipsis, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { goalIsTerminal, type GoalBudget, type GoalControlRequest, type SessionGoal } from "@pi-desktop/shared";
import { Button, TooltipButton } from "../../components/ui";
import { GoalDetailsDialog } from "./GoalDetailsDialog";
import { GoalResumeDialog } from "./GoalResumeDialog";
import { GoalEditDialog } from "./GoalEditDialog";
import { GoalDeleteDialog } from "./GoalDeleteDialog";
import { GoalElapsed } from "./GoalElapsed";
import type { GoalControl } from "./session-goal-service";
import "./goal.css";

export interface GoalStatusBarProps {
  goal: SessionGoal;
  pending?: GoalControlRequest["action"] | null;
  error?: string | null;
  onControl: GoalControl;
  onReload?: () => void;
}

/** One attached header; every larger surface portals outside the measured dock. */
export function GoalStatusBar({ goal, pending, error, onControl, onReload }: GoalStatusBarProps) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<"details" | "resume" | "edit" | "delete" | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogVersion = useRef(0);
  const close = useCallback(() => { dialogVersion.current++; setDialog(null); }, []);
  useEffect(() => () => { dialogVersion.current++; }, []);
  const terminal = goalIsTerminal(goal);
  const resumable = ["paused", "blocked", "budget_exhausted"].includes(goal.status);
  const settled = !goal.activeTurnId;
  useEffect(() => {
    if ((dialog === "resume" && !resumable) || (dialog === "edit" && terminal)) close();
  }, [dialog, resumable, terminal, close]);
  const open = (kind: NonNullable<typeof dialog>, trigger: HTMLElement) => {
    dialogVersion.current++; returnFocus.current = trigger; setDialog(kind);
    if (kind === "edit" && goal.status === "active") void onControl("pause");
  };
  const submit = async (action: "edit" | "resume" | "delete", budget?: GoalBudget, objective?: string) => {
    const owner = dialogVersion.current;
    if (await onControl(action, budget, objective) && owner === dialogVersion.current) close();
  };
  const state = pending === "pause" ? "autonomousGoal.pausing" : pending === "resume" ? "autonomousGoal.resuming" : pending === "delete" ? "autonomousGoal.deleting" : pending === "cancel" ? "autonomousGoal.cancelling" : `autonomousGoal.status.${goal.status}`;
  return <section className="goal-status" aria-label={t("autonomousGoal.region")} aria-busy={Boolean(pending)}>
    <div className="goal-status-bar" data-testid="goal-status-bar">
      <span className={`goal-state-dot goal-state-${goal.status}`} aria-hidden="true" />
      <span className="goal-state" role="status">{t(state)}</span>
      <span className="goal-summary" title={goal.objective}>{goal.objective}</span>
      <GoalElapsed goal={goal} />
      {!terminal ? <TooltipButton className="goal-icon-button" data-goal-action="edit" tooltip={t("autonomousGoal.edit")} disabled={Boolean(pending)}
        onClick={(event) => open("edit", event.currentTarget)}><Pencil size={14} aria-hidden="true" /></TooltipButton> : null}
      {goal.status === "active" ? <TooltipButton className="goal-icon-button" data-goal-action="pause" tooltip={t("autonomousGoal.pauseHint")} ariaLabel={t("autonomousGoal.pause")} disabled={Boolean(pending)}
        onClick={() => void onControl("pause")}><Pause size={14} aria-hidden="true" /></TooltipButton> : null}
      {resumable ? <TooltipButton className="goal-icon-button" data-goal-action="resume" tooltip={t(!settled ? "autonomousGoal.pauseFirst" : "autonomousGoal.resume")} ariaLabel={t("autonomousGoal.resume")} disabled={Boolean(pending) || !settled}
        onClick={(event) => goal.status === "budget_exhausted" ? open("resume", event.currentTarget) : void onControl("resume")}><Play size={14} aria-hidden="true" /></TooltipButton> : null}
      <TooltipButton className="goal-icon-button" data-goal-action="delete" tooltip={t("autonomousGoal.delete")} disabled={Boolean(pending)}
        onClick={(event) => open("delete", event.currentTarget)}><Trash2 size={14} aria-hidden="true" /></TooltipButton>
      <TooltipButton className="goal-icon-button" data-goal-action="details" tooltip={t("autonomousGoal.viewDetails")} aria-haspopup="dialog" aria-expanded={dialog === "details"}
        onClick={(event) => open("details", event.currentTarget)}><CircleEllipsis size={14} aria-hidden="true" /></TooltipButton>
    </div>
    {error && !dialog ? <div className="goal-control-error goal-error" role="alert"><span>{t("autonomousGoal.controlError", { message: error })}</span>
      {onReload ? <Button size="sm" variant="ghost" onClick={onReload} disabled={Boolean(pending)}>{t("autonomousGoal.reload")}</Button> : null}
    </div> : null}
    {dialog === "details" ? <GoalDetailsDialog goal={goal} onClose={close} returnFocus={returnFocus.current}
      onAdjustResume={resumable && settled && !pending ? () => { dialogVersion.current++; setDialog("resume"); } : undefined} /> : null}
    {dialog === "resume" ? <GoalResumeDialog goal={goal} pending={Boolean(pending)} error={error}
      onResume={(budget) => void submit("resume", budget)} onReload={onReload} onClose={close} returnFocus={returnFocus.current} /> : null}
    {dialog === "edit" ? <GoalEditDialog goal={goal} pending={Boolean(pending)} error={error}
      onSave={(objective) => void submit("edit", undefined, objective)} onPause={() => void onControl("pause")} onReload={onReload} onClose={close} returnFocus={returnFocus.current} /> : null}
    {dialog === "delete" ? <GoalDeleteDialog pending={Boolean(pending)} error={error} onDelete={() => void submit("delete")}
      onReload={onReload} onClose={close} returnFocus={returnFocus.current} /> : null}
  </section>;
}
