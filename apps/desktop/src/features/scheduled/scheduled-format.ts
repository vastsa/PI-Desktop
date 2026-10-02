import type { ScheduledTask, ScheduledTaskSchedule } from "@pi-desktop/shared";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Compact, language-neutral run length (`42s`, `1m 12s`, `2h 05m`). Durations
 * stay unit-suffixed on purpose: the component spec renders them the same way
 * in the transcript timeline and the E2E logs, and every locale reads them.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${hours}h`;
}

/** Absolute localized moment, used where a relative phrase would be vague. */
export function formatMoment(value: string | null | undefined, locale?: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(parsed));
  } catch {
    return new Date(parsed).toLocaleString();
  }
}

/**
 * Relative phrase for a past ("2 hours ago") or future ("in 3 hours") moment.
 * Beyond a week it falls back to an absolute date, so a next run three weeks
 * out never reads as a countdown nobody can convert.
 */
export function formatRelativeMoment(
  value: string | null | undefined,
  now: number,
  locale?: string,
): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  const delta = parsed - now;
  const magnitude = Math.abs(delta);
  if (magnitude >= WEEK_MS) return formatMoment(value, locale);
  try {
    const relative = new Intl.RelativeTimeFormat(locale || undefined, {
      numeric: "auto",
    });
    if (magnitude < MINUTE_MS) return relative.format(Math.round(delta / 1000), "second");
    if (magnitude < HOUR_MS) return relative.format(Math.round(delta / MINUTE_MS), "minute");
    if (magnitude < DAY_MS) return relative.format(Math.round(delta / HOUR_MS), "hour");
    return relative.format(Math.round(delta / DAY_MS), "day");
  } catch {
    return formatMoment(value, locale);
  }
}

/** `HH:MM` for a saved calendar intent; `null` when the task has no clock. */
export function formatScheduleClock(
  schedule: ScheduledTaskSchedule | null | undefined,
): string | null {
  if (!schedule) return null;
  const hour = Math.trunc(schedule.hour);
  const minute = Math.trunc(schedule.minute);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The newest timestamp a task row can report as "last attempt". */
export function lastAttemptAt(task: ScheduledTask): string | null {
  return task.lastRunAt ?? null;
}

/**
 * Elapsed minutes an `interval` task waits between runs, as stored. Mirrors
 * `INTERVAL_MIN_MINUTES` / `INTERVAL_MAX_MINUTES` in
 * `crates/host-core/src/scheduled/timing.rs`, which stays authoritative: the
 * host refuses to arm anything outside this range.
 */
export const SCHEDULED_INTERVAL_MINUTES = { min: 5, max: 1440 } as const;

/**
 * A stored interval in the largest whole unit that still states it exactly, so
 * `60` reports as one hour rather than sixty minutes. `null` when the value
 * cannot describe an interval — the same values the host refuses to arm.
 */
export function intervalAmount(
  minutes: number | null | undefined,
): { unit: "minutes" | "hours"; value: number } | null {
  if (minutes === null || minutes === undefined) return null;
  const value = Math.trunc(minutes);
  if (
    !Number.isFinite(value) ||
    value < SCHEDULED_INTERVAL_MINUTES.min ||
    value > SCHEDULED_INTERVAL_MINUTES.max
  ) {
    return null;
  }
  return value % 60 === 0
    ? { unit: "hours", value: value / 60 }
    : { unit: "minutes", value };
}

/** The same span in another unit, clamped into the range the host arms. */
export function convertInterval(
  value: number,
  from: "minutes" | "hours",
  to: "minutes" | "hours",
): number {
  if (from === to || !Number.isFinite(value)) return value;
  if (to === "hours") {
    return Math.min(SCHEDULED_INTERVAL_MINUTES.max / 60, Math.max(1, Math.round(value / 60)));
  }
  return Math.min(
    SCHEDULED_INTERVAL_MINUTES.max,
    Math.max(SCHEDULED_INTERVAL_MINUTES.min, Math.round(value * 60)),
  );
}
