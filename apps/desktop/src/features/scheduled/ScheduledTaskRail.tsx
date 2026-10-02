import { useTranslation } from "react-i18next";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { cx } from "../../components/ui";
import {
  IconCircleAlert,
  IconCircleCheck,
  IconClock,
  IconDot,
  IconStop,
} from "../../components/icons";
import { formatDuration, formatRelativeMoment, formatScheduleClock } from "./scheduled-format";
import { runDurationMs } from "./scheduled-runs";
import { cadenceHasClock, cadenceLabel, RUN_STATUS_I18N_KEYS } from "./scheduled-labels";

function RunGlyph({ run }: { run: ScheduledTaskRun }) {
  switch (run.status) {
    case "completed":
      return <IconCircleCheck size={13} />;
    case "error":
      return <IconCircleAlert size={13} />;
    case "aborted":
      return <IconStop size={12} />;
    default:
      return <IconDot size={13} />;
  }
}

/** The task column: one row per task, each reporting its own last outcome and
 * next occurrence so the page answers "did it run, and did it work?" without a
 * second, global run list. */
export function ScheduledTaskRail({
  tasks,
  latestRuns,
  selectedTaskId,
  now,
  locale,
  onSelect,
}: {
  tasks: ScheduledTask[];
  latestRuns: Map<string, ScheduledTaskRun>;
  selectedTaskId: string | null;
  now: number;
  locale: string;
  onSelect: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const total = tasks.length;
  return (
    <aside className="scheduled-rail">
      <div className="scheduled-card-head">
        <h2 className="scheduled-card-title" id="scheduled-task-rail-label">
          {t("scheduled.tasks")}
        </h2>
        <span className="scheduled-card-count">{total}</span>
      </div>
      <ul className="scheduled-rail-list" aria-labelledby="scheduled-task-rail-label">
        {tasks.map((task) => {
          const selected = task.id === selectedTaskId;
          const latest = latestRuns.get(task.id) ?? null;
          const duration = runDurationMs(latest);
          const clock = cadenceHasClock(task.cadence) ? formatScheduleClock(task.schedule) : null;
          const cadence = cadenceLabel(t, task);
          const running = latest?.status === "running";
          return (
            <li key={task.id}>
              <button
                type="button"
                className={cx("scheduled-task", selected && "is-selected")}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(task.id)}
              >
                <span className="scheduled-task-title">
                  <span className="scheduled-task-name">{task.title}</span>
                  {running ? (
                    <span className="scheduled-task-live" aria-hidden>
                      <IconDot size={10} />
                    </span>
                  ) : null}
                  {!task.enabled && (
                    <span className="scheduled-task-paused">{t("scheduled.disabled")}</span>
                  )}
                </span>
                <span className="scheduled-task-cadence">
                  <IconClock size={12} aria-hidden />
                  {clock ? `${cadence} · ${clock}` : cadence}
                </span>
                {latest ? (
                  <span className={cx("scheduled-task-last", `is-${latest.status}`)}>
                    <RunGlyph run={latest} />
                    <span className="scheduled-task-last-text">
                      {t(RUN_STATUS_I18N_KEYS[latest.status])}
                      {" · "}
                      {formatRelativeMoment(latest.startedAt, now, locale)}
                      {duration === null ? "" : ` · ${formatDuration(duration)}`}
                    </span>
                  </span>
                ) : (
                  <span className="scheduled-task-last is-empty">{t("scheduled.neverRun")}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
