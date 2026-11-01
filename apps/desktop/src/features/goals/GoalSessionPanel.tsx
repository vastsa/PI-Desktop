import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { GoalStatusBar } from "./GoalStatusBar";
import { useSessionGoal } from "./useSessionGoal";
import "./goal.css";

/** One authoritative snapshot drives both the attached header and TaskDock visibility. */
export function GoalSessionPanel({ taskDock, beforeComposer, children }: {
  taskDock?: ReactNode;
  beforeComposer?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.activeSessionId));
  const mode = useAppStore((state) => state.draftConfiguration?.mode ?? state.settings?.defaultMode ?? "agent");
  const goalMode = (session?.mode ?? mode) === "goal";
  const unsupported = isRemoteSession(session) || session?.source === "pi-native";
  const state = useSessionGoal(session && !unsupported ? session.id : null);
  // Keep task state mounted, but fail closed while the new session's presence is unknown.
  const hideTasks = Boolean(state.goal || state.loading || state.error);
  return <>
    <div className="goal-task-fallback" hidden={hideTasks}>{taskDock}</div>
    {beforeComposer}
    <div className={`goal-composer-connection${state.goal ? " has-goal" : ""}`}>
      {state.goal ? <GoalStatusBar key={`${session?.id}:${state.goal.id}`} goal={state.goal} pending={state.pending} error={state.error}
        onControl={state.control} onReload={() => void state.reload()} /> : null}
      {state.loading && !state.goal && goalMode ? <p className="goal-presence-message goal-hint" role="status">{t("autonomousGoal.loading")}</p> : null}
      {state.error && !state.goal ? <div className="goal-presence-message goal-error" role="alert"><span>{t("autonomousGoal.loadError", { message: state.error })}</span>
        <Button size="sm" onClick={() => void state.reload()}>{t("autonomousGoal.reload")}</Button>
      </div> : null}
      {unsupported && goalMode ? <p className="goal-presence-message goal-hint">{t("autonomousGoal.localOnly")}</p> : null}
      {children}
    </div>
  </>;
}
