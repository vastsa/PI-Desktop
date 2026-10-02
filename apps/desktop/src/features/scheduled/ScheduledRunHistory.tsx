import { useTranslation } from "react-i18next";
import type { ScheduledTaskRun } from "@pi-desktop/shared";
import { TooltipButton, cx } from "../../components/ui";
import {
  IconChevronDown,
  IconCircleAlert,
  IconCircleCheck,
  IconDot,
  IconExternal,
  IconStop,
} from "../../components/icons";
import { formatDuration, formatMoment } from "./scheduled-format";
import { runDurationMs } from "./scheduled-runs";
import { RUN_STATUS_I18N_KEYS } from "./scheduled-labels";

function RunStatusGlyph({ status }: { status: ScheduledTaskRun["status"] }) {
  switch (status) {
    case "completed":
      return <IconCircleCheck size={15} />;
    case "error":
      return <IconCircleAlert size={15} />;
    case "aborted":
      return <IconStop size={14} />;
    default:
      return <IconDot size={15} />;
  }
}

/** One task's own runs, newest first. Selecting a row reads that run in the
 * page; opening its conversation stays a separate, explicit action. */
export function ScheduledRunHistory({
  runs,
  selectedRunId,
  busy,
  locale,
  onSelectRun,
  onOpenSession,
}: {
  runs: ScheduledTaskRun[];
  selectedRunId: string | null;
  busy: boolean;
  locale: string;
  onSelectRun: (runId: string) => void;
  onOpenSession: (sessionId: string, runId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="scheduled-card" aria-labelledby="scheduled-run-history">
      <div className="scheduled-card-head">
        <h3 className="scheduled-card-title" id="scheduled-run-history">
          {t("scheduled.runs")}
        </h3>
        <span className="scheduled-card-count">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="scheduled-hint">{t("scheduled.emptyRuns")}</p>
      ) : (
        <>
          <p className="scheduled-hint">{t("scheduled.historyHint")}</p>
          <ol className="scheduled-runs">
            {runs.map((run) => {
              const selected = run.id === selectedRunId;
              const duration = runDurationMs(run);
              const sessionId = run.sessionId;
              const meta = [
                formatMoment(run.startedAt, locale),
                duration === null ? "" : formatDuration(duration),
                run.errorCode ?? "",
              ].filter(Boolean);
              return (
                <li key={run.id} className={cx("scheduled-run", selected && "is-selected")}>
                  <button
                    type="button"
                    className="scheduled-run-main"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectRun(run.id)}
                  >
                    <span className={cx("scheduled-run-glyph", `is-${run.status}`)} aria-hidden>
                      <RunStatusGlyph status={run.status} />
                    </span>
                    <span className="scheduled-run-body">
                      <span className="scheduled-run-state">{t(RUN_STATUS_I18N_KEYS[run.status])}</span>
                      <span className="scheduled-run-meta">{meta.join(" · ")}</span>
                    </span>
                    <IconChevronDown
                      size={14}
                      className={cx("scheduled-run-chevron", selected && "is-open")}
                      aria-hidden
                    />
                  </button>
                  {sessionId && (
                    <TooltipButton
                      tooltip={t("scheduled.openResult")}
                      ariaLabel={t("scheduled.openResult")}
                      className="scheduled-icon-btn"
                      disabled={busy}
                      onClick={() => onOpenSession(sessionId, run.id)}
                    >
                      <IconExternal size={14} aria-hidden />
                    </TooltipButton>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
