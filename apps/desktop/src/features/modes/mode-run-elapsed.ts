export interface ModeRunElapsedInput {
  state: string;
  elapsedMs?: number;
  activeSinceMs?: number;
}

export interface ModeRunElapsedUnits {
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function nonnegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Host-owned active time only; legacy runs never derive time from createdAt. */
export function modeRunElapsedMs(run: ModeRunElapsedInput, nowMs: number): number {
  const accumulated = nonnegativeFinite(run.elapsedMs);
  if (
    run.state !== "running" ||
    typeof run.activeSinceMs !== "number" ||
    !Number.isFinite(run.activeSinceMs) ||
    !Number.isFinite(nowMs)
  ) {
    return accumulated;
  }
  return Math.min(Number.MAX_VALUE, accumulated + Math.max(0, nowMs - run.activeSinceMs));
}

/** Compact whole units, with days retained rather than wrapping at 24 hours. */
export function formatModeRunElapsed(elapsedMs: number, units: ModeRunElapsedUnits): string {
  const seconds = Math.floor(nonnegativeFinite(elapsedMs) / 1000);
  const parts = [
    [Math.floor(seconds / 86_400), units.day],
    [Math.floor((seconds % 86_400) / 3600), units.hour],
    [Math.floor((seconds % 3600) / 60), units.minute],
    [seconds % 60, units.second],
  ] as const;
  return parts.filter(([value]) => value > 0).map(([value, unit]) => `${value} ${unit}`).join(" ") || `0 ${units.second}`;
}
