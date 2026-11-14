import { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { formatModeRunElapsed, modeRunElapsedMs, type ModeRunElapsedInput } from "./mode-run-elapsed";

/** Refreshes only while the Host reports an active interval; never persists time. */
export function ModeRunElapsed({ run }: { run: ModeRunElapsedInput & { id: string; revision: number } }) {
  const { t } = useTranslation();
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  const ticking = run.state === "running" && typeof run.activeSinceMs === "number" && Number.isFinite(run.activeSinceMs);

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [ticking, run.id, run.revision, run.elapsedMs, run.activeSinceMs]);

  // Compute from current props and the clock, not a previous run's timer state.
  const elapsed = formatModeRunElapsed(modeRunElapsedMs(run, Date.now()), {
    day: "d",
    hour: "h",
    minute: "m",
    second: "s",
  });
  const label = t("modes.run.elapsed", { duration: elapsed });
  return <span className="mode-run-elapsed" title={label} aria-label={label}>{elapsed}</span>;
}
