import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { Badge, Button, cx } from "../../components/ui";
import { IconChevronDown, IconExternal } from "../../components/icons";
import { PERMISSION_MODE_I18N_KEYS } from "../../lib/permission-mode-labels";
import { shortenPath } from "../../lib/project-archive";
import {
  formatDuration,
  formatMoment,
  formatRelativeMoment,
  formatScheduleClock,
} from "./scheduled-format";
import { resolveSelectedRun, runDurationMs } from "./scheduled-runs";
import { cadenceHasClock, cadenceLabel, CADENCE_I18N_KEYS, RUN_STATUS_I18N_KEYS } from "./scheduled-labels";
import { ScheduledRunHistory } from "./ScheduledRunHistory";
import { ScheduledRunTranscript } from "./ScheduledRunTranscript";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="scheduled-fact">
      <dt className="scheduled-fact-label">{label}</dt>
      <dd className="scheduled-fact-value">{children}</dd>
    </div>
  );
}

/**
 * One task's page: what it does next, how its last run ended, its own run
 * history, and the transcript of the run the reader picked — all inside the
 * route, so reviewing a run no longer costs a conversation switch.
 */
export function ScheduledTaskDetail({
  task,
  runs,
  selectedRunId,
  running,
  busy,
  now,
  locale,
  onSelectRun,
  onOpenSession,
  onRunNow,
  onEdit,
  onToggleEnabled,
  onDelete,
  providerName,
}: {
  task: ScheduledTask;
  runs: ScheduledTaskRun[];
  selectedRunId: string | null;
  running: boolean;
  busy: boolean;
  now: number;
  locale: string;
  onSelectRun: (runId: string) => void;
  onOpenSession: (sessionId: string, runId: string) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
  /** Display name of the task's provider; the stored id is a UUID. */
  providerName?: string | null;
}) {
  const { t } = useTranslation();
  const [instructionOpen, setInstructionOpen] = useState(false);
  const latest = runs[0] ?? null;
  const latestDuration = runDurationMs(latest);
  const clock = cadenceHasClock(task.cadence) ? formatScheduleClock(task.schedule) : null;
  const cadence = cadenceLabel(t, task);
  const selectedRun = resolveSelectedRun(runs, selectedRunId);
  const selectedDuration = runDurationMs(selectedRun);
  const selectedSessionId = selectedRun?.sessionId ?? null;
  const project = task.workspacePath ? shortenPath(task.workspacePath) : "";
  // The stored provider id is a UUID; the facts row shows the provider's name
  // beside the model, and falls back to the model alone when it is unknown.
  const model = task.modelId
    ? [providerName, task.modelId].filter(Boolean).join(" / ")
    : t("settings.defaultModel");
  const nextRun =
    task.enabled && task.cadence !== "manual" && task.nextRunAt
      ? `${formatRelativeMoment(task.nextRunAt, now, locale)} · ${formatMoment(task.nextRunAt, locale)}`
      : t(
          task.enabled && task.cadence !== "manual" && !task.schedule
            ? "scheduled.legacyHint"
            : "scheduled.noNextRun",
        );

  return (
    <section className="scheduled-detail" aria-labelledby="scheduled-detail-title">
      <div className="scheduled-detail-head">
        <div className="scheduled-detail-heading">
          <h2 className="scheduled-detail-title" id="scheduled-detail-title">
            {task.title}
          </h2>
          <div className="scheduled-detail-badges">
            <Badge tone={task.enabled ? "success" : "neutral"}>
              {t(task.enabled ? "scheduled.enabled" : "scheduled.disabled")}
            </Badge>
            {running ? <Badge tone="warning">{t("scheduled.statusRunning")}</Badge> : null}
          </div>
        </div>
        <div className="scheduled-detail-actions">
          <Button size="sm" variant="primary" disabled={busy || running} onClick={onRunNow}>
            {t(running ? "scheduled.statusRunning" : "scheduled.runNow")}
          </Button>
          <Button size="sm" disabled={busy} onClick={onEdit}>
            {t("scheduled.edit")}
          </Button>
          <Button size="sm" disabled={busy} onClick={onToggleEnabled}>
            {t(task.enabled ? "scheduled.pause" : "scheduled.resume")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || running} onClick={onDelete}>
            {t("scheduled.delete")}
          </Button>
        </div>
      </div>

      <dl className="scheduled-facts">
        <Fact label={t("scheduled.lastRun")}>
          {latest ? (
            <span className={cx("scheduled-fact-run", `is-${latest.status}`)}>
              {t(RUN_STATUS_I18N_KEYS[latest.status])}
              {" · "}
              {formatRelativeMoment(latest.startedAt, now, locale)}
              {latestDuration === null ? "" : ` · ${formatDuration(latestDuration)}`}
            </span>
          ) : (
            t("scheduled.neverRun")
          )}
        </Fact>
        <Fact label={t("scheduled.nextRun")}>{nextRun}</Fact>
        <Fact label={t("scheduled.cadence")}>{clock ? `${cadence} · ${clock}` : cadence}</Fact>
        {project ? <Fact label={t("scheduled.detailProject")}>{project}</Fact> : null}
        <Fact label={t("scheduled.detailPermission")}>
          {t(PERMISSION_MODE_I18N_KEYS[task.permissionMode ?? "inherit"])}
        </Fact>
        <Fact label={t("scheduled.detailModel")}>{model}</Fact>
        <Fact label={t("scheduled.sessionMode")}>
          {t(
            task.sessionMode === "reuse"
              ? "scheduled.sessionModeReuse"
              : "scheduled.sessionModePerRun",
          )}
        </Fact>
      </dl>

      <section className="scheduled-card" aria-labelledby="scheduled-instruction">
        <div className="scheduled-card-head">
          <h3 className="scheduled-card-title" id="scheduled-instruction">
            {t("scheduled.prompt")}
          </h3>
          <button
            type="button"
            className="scheduled-disclosure"
            aria-expanded={instructionOpen}
            onClick={() => setInstructionOpen((open) => !open)}
          >
            {t(instructionOpen ? "scheduled.instructionHide" : "scheduled.instructionShow")}
            <IconChevronDown
              size={13}
              className={cx("scheduled-run-chevron", instructionOpen && "is-open")}
              aria-hidden
            />
          </button>
        </div>
        <p className={cx("scheduled-instruction", instructionOpen && "is-open")}>
          {task.prompt}
        </p>
      </section>

      <ScheduledRunHistory
        runs={runs}
        selectedRunId={selectedRun?.id ?? null}
        busy={busy}
        locale={locale}
        onSelectRun={onSelectRun}
        onOpenSession={onOpenSession}
      />

      {selectedRun ? (
        <section className="scheduled-card scheduled-content" aria-labelledby="scheduled-run-content">
          <div className="scheduled-card-head">
            <h3 className="scheduled-card-title" id="scheduled-run-content">
              {t("scheduled.runContent")}
            </h3>
            <span className="scheduled-content-meta">
              <span className={cx("scheduled-fact-run", `is-${selectedRun.status}`)}>
                {t(RUN_STATUS_I18N_KEYS[selectedRun.status])}
              </span>
              {" · "}
              {formatMoment(selectedRun.startedAt, locale)}
              {selectedDuration === null ? "" : ` · ${formatDuration(selectedDuration)}`}
            </span>
            {selectedSessionId ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenSession(selectedSessionId, selectedRun.id)}
              >
                <IconExternal size={13} aria-hidden />
                {t("scheduled.openResult")}
              </Button>
            ) : null}
          </div>
          <ScheduledRunTranscript run={selectedRun} />
        </section>
      ) : null}
    </section>
  );
}
