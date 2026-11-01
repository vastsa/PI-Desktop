import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionGoal } from "@pi-desktop/shared";

export function goalElapsedSeconds(goal: Pick<SessionGoal, "status" | "elapsedSeconds" | "activeSinceMs">, now: number): number {
  const accumulated = Number.isFinite(goal.elapsedSeconds) ? Math.max(0, goal.elapsedSeconds ?? 0) : 0;
  const interval = goal.status === "active" && Number.isFinite(goal.activeSinceMs)
    ? Math.max(0, now - (goal.activeSinceMs ?? now)) / 1000 : 0;
  return Math.floor(accumulated + interval);
}

/** A view clock only: elapsed ownership and interval origin always remain with the host. */
export function GoalElapsed({ goal }: { goal: SessionGoal }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const ticking = goal.status === "active" && Number.isFinite(goal.activeSinceMs);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [goal.id, goal.activeSinceMs, ticking]);
  const seconds = goalElapsedSeconds(goal, now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const elapsed = t("autonomousGoal.elapsed", { hours: pad(Math.floor(seconds / 3600)), minutes: pad(Math.floor(seconds / 60) % 60), seconds: pad(seconds % 60) });
  return <span className="goal-elapsed" data-testid="goal-elapsed" aria-label={t("autonomousGoal.elapsedLabel", { elapsed })}>{elapsed}</span>;
}
