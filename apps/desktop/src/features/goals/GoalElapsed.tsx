import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionGoal } from "@pi-desktop/shared";

export type GoalElapsedUnits = {
  day: string;
  hour: string;
  minute: string;
  second: string;
};

const DEFAULT_UNITS: GoalElapsedUnits = {
  day: "d",
  hour: "h",
  minute: "m",
  second: "s",
};

export function formatGoalElapsed(
  elapsedSeconds: number,
  units: GoalElapsedUnits = DEFAULT_UNITS,
): string {
  const totalSeconds = Number.isFinite(elapsedSeconds)
    ? Math.max(0, Math.floor(elapsedSeconds))
    : 0;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const elapsed = [
    ...(days > 0 ? [`${days}${units.day}`] : []),
    ...(hours > 0 ? [`${hours}${units.hour}`] : []),
    ...(minutes > 0 ? [`${minutes}${units.minute}`] : []),
    ...(seconds > 0 ? [`${seconds}${units.second}`] : []),
  ];
  return elapsed.length > 0 ? elapsed.join(" ") : `0${units.second}`;
}

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
  const elapsed = formatGoalElapsed(seconds, {
    day: t("autonomousGoal.elapsedDayUnit", { defaultValue: "d" }),
    hour: t("autonomousGoal.elapsedHourUnit", { defaultValue: "h" }),
    minute: t("autonomousGoal.elapsedMinuteUnit", { defaultValue: "m" }),
    second: t("autonomousGoal.elapsedSecondUnit", { defaultValue: "s" }),
  });
  return <span className="goal-elapsed" data-testid="goal-elapsed" aria-label={t("autonomousGoal.elapsedLabel", { elapsed })}>{elapsed}</span>;
}
