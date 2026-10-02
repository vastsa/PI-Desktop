import type { TFunction } from "i18next";
import type { ScheduledTask, ScheduledTaskCadence, ScheduledTaskRun } from "@pi-desktop/shared";
import { intervalAmount } from "./scheduled-format";

/** One vocabulary for run status and cadence labels, shared by the rail, the
 * history rows, the detail facts, and the run-content header. */
export const RUN_STATUS_I18N_KEYS: Record<ScheduledTaskRun["status"], string> = {
  running: "scheduled.statusRunning",
  completed: "scheduled.statusCompleted",
  aborted: "scheduled.statusAborted",
  error: "scheduled.statusError",
};

export const CADENCE_I18N_KEYS = {
  manual: "scheduled.cadenceManual",
  hourly: "scheduled.cadenceHourly",
  interval: "scheduled.interval",
  daily: "scheduled.cadenceDaily",
  weekly: "scheduled.cadenceWeekly",
} as const;

/** Only a calendar cadence has a clock to report beside its name: an interval
 * states elapsed minutes, and hourly counts from the moment it was armed. */
export function cadenceHasClock(cadence: ScheduledTaskCadence): boolean {
  return cadence === "daily" || cadence === "weekly";
}

/**
 * A task's cadence in one phrase. An interval carries its own value — that
 * value *is* the schedule — while a calendar cadence is named by its kind and
 * reports its clock separately.
 */
export function cadenceLabel(t: TFunction, task: ScheduledTask): string {
  const amount = intervalAmount(task.schedule?.intervalMinutes);
  if (task.cadence !== "interval" || !amount) return t(CADENCE_I18N_KEYS[task.cadence]);
  const value =
    amount.unit === "hours"
      ? t("scheduled.intervalHours", { count: amount.value })
      : t("scheduled.intervalMinutes", { count: amount.value });
  return t("scheduled.intervalEvery", { value });
}
