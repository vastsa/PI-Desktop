import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GlobalPermissionMode,
  ProjectRecord,
  ScheduledSessionMode,
  ScheduledTask,
  ScheduledTaskSchedule,
} from "@pi-desktop/shared";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { ScheduledWeekdaySelect } from "./ScheduledWeekdaySelect";
import { convertInterval, intervalAmount, SCHEDULED_INTERVAL_MINUTES } from "./scheduled-format";
import {
  ScheduledExecutionSettings,
  type ScheduledModelSelection,
} from "./ScheduledExecutionSettings";
import { useAppStore } from "../../stores/app-store";
import "./scheduled-editor.css";

export type ScheduledDraft = Pick<ScheduledTask, "title" | "prompt" | "cadence" | "schedule"> & {
  workspacePath?: string;
  permissionMode?: GlobalPermissionMode;
  providerId?: string | null;
  modelId?: string | null;
  thinkingLevel?: ScheduledTask["thinkingLevel"] | null;
  sessionMode?: ScheduledSessionMode;
};

export function ScheduledEditor({
  task,
  projects,
  currentWorkspacePath,
  busy,
  save,
  cancel,
}: {
  task?: ScheduledTask;
  projects: readonly ProjectRecord[];
  currentWorkspacePath: string;
  busy: boolean;
  save: (draft: ScheduledDraft) => Promise<void>;
  cancel: () => void;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [cadence, setCadence] = useState<ScheduledTask["cadence"]>(task?.cadence ?? "manual");
  const [hour, setHour] = useState(String(task?.schedule?.hour ?? 9).padStart(2, "0"));
  const [minute, setMinute] = useState(String(task?.schedule?.minute ?? 0).padStart(2, "0"));
  const [weekdays, setWeekdays] = useState<number[]>(
    task?.schedule?.weekdays ?? [task?.schedule?.weekday ?? 0],
  );
  const [workspacePath, setWorkspacePath] = useState(
    task?.workspacePath || currentWorkspacePath || projects[0]?.path || "",
  );
  const [workspaceTouched, setWorkspaceTouched] = useState(false);
  const [permissionMode, setPermissionMode] = useState<GlobalPermissionMode>(
    task?.permissionMode ?? "ask",
  );
  const [permissionTouched, setPermissionTouched] = useState(false);
  // A conversation mode always has a value, so it is saved with every draft.
  const [sessionMode, setSessionMode] = useState<ScheduledSessionMode>(
    task?.sessionMode ?? "perRun",
  );

  // An interval is one number plus the unit it reads in. The stored value is
  // always minutes, which is what the host arms and what the rail reports.
  const storedInterval = intervalAmount(task?.schedule?.intervalMinutes) ?? {
    unit: "minutes" as const,
    value: 30,
  };
  const [intervalValue, setIntervalValue] = useState(String(storedInterval.value));
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(storedInterval.unit);
  const intervalMinutes =
    intervalUnit === "hours" ? Number(intervalValue) * 60 : Number(intervalValue);
  const validInterval =
    Number.isInteger(Number(intervalValue)) &&
    intervalMinutes >= SCHEDULED_INTERVAL_MINUTES.min &&
    intervalMinutes <= SCHEDULED_INTERVAL_MINUTES.max;
  const intervalFloor = intervalUnit === "hours" ? 1 : SCHEDULED_INTERVAL_MINUTES.min;
  const intervalCeiling =
    intervalUnit === "hours"
      ? SCHEDULED_INTERVAL_MINUTES.max / 60
      : SCHEDULED_INTERVAL_MINUTES.max;
  /** The same span in the other unit, clamped into the stored range. */
  const switchIntervalUnit = (unit: "minutes" | "hours") => {
    const current = Number(intervalValue);
    setIntervalValue(
      String(convertInterval(Number.isFinite(current) ? current : 30, intervalUnit, unit)),
    );
    setIntervalUnit(unit);
  };
  const defaultModel = !task && settings?.defaultProviderId && settings.defaultModelId
    ? { providerId: settings.defaultProviderId, modelId: settings.defaultModelId }
    : {};
  const [modelSelection, setModelSelection] = useState<ScheduledModelSelection>(
    task?.providerId && task.modelId
      ? { providerId: task.providerId, modelId: task.modelId, thinkingLevel: task.thinkingLevel }
      : { ...defaultModel, thinkingLevel: task?.thinkingLevel },
  );
  const [modelTouched, setModelTouched] = useState(false);
  useEffect(() => {
    if (workspacePath) return;
    const fallback = currentWorkspacePath || projects[0]?.path;
    if (fallback) setWorkspacePath(fallback);
  }, [currentWorkspacePath, projects, workspacePath]);
  const validTime = hour !== "" && minute !== "" && Number.isInteger(Number(hour)) &&
    Number.isInteger(Number(minute)) && Number(hour) >= 0 && Number(hour) < 24 &&
    Number(minute) >= 0 && Number(minute) < 60;
  const valid = !!prompt.trim() && !!title.trim() &&
    ((cadence !== "daily" && cadence !== "weekly") || validTime) &&
    (cadence !== "weekly" || weekdays.length > 0) &&
    (cadence !== "interval" || validInterval);
  const periods = [
    { id: "morning", label: t("scheduled.morning"), hour: "09" },
    { id: "afternoon", label: t("scheduled.afternoon"), hour: "14" },
    { id: "evening", label: t("scheduled.evening"), hour: "19" },
    { id: "night", label: t("scheduled.night"), hour: "22" },
  ];
  const period = minute === "00" ? periods.find((item) => item.hour === hour) : undefined;
  const cadences = [
    ["manual", "scheduled.cadenceManual"],
    ["hourly", "scheduled.cadenceHourly"],
    ["interval", "scheduled.interval"],
    ["daily", "scheduled.cadenceDaily"],
    ["weekly", "scheduled.cadenceWeekly"],
  ] as const;

  // The interval value rides along with every armed cadence, so a task that
  // switches between a calendar and an interval keeps the value for the way
  // back. A number the field refuses is left out rather than saved.
  const scheduleFor = (): ScheduledTaskSchedule | null => {
    if (cadence === "manual") return null;
    const base = {
      hour: 0,
      minute: 0,
      weekday: 0,
      ...(validInterval ? { intervalMinutes } : {}),
    };
    if (cadence === "hourly" || cadence === "interval") return base;
    return {
      ...base,
      hour: Number(hour),
      minute: Number(minute),
      weekday: weekdays[0] ?? 0,
      ...(cadence === "weekly" ? { weekdays } : {}),
    };
  };

  return (
    <form
      className="dest-create space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !valid) return;
        const executionSettings: Pick<
          ScheduledDraft,
          "workspacePath" | "permissionMode" | "providerId" | "modelId" | "thinkingLevel" | "sessionMode"
        > = {};
        if (!task || task.workspacePath || workspaceTouched) {
          if (workspacePath) executionSettings.workspacePath = workspacePath;
        }
        if (!task || task.permissionMode || permissionTouched) {
          executionSettings.permissionMode = permissionMode;
        }
        if (!task || (task.providerId && task.modelId) || modelTouched) {
          executionSettings.providerId = modelSelection.providerId ?? null;
          executionSettings.modelId = modelSelection.modelId ?? null;
        }
        if (modelTouched || task?.thinkingLevel) {
          executionSettings.thinkingLevel = modelSelection.thinkingLevel ?? null;
        }
        // The mode always has a value, so it is saved with every draft.
        executionSettings.sessionMode = sessionMode;
        void save({
          title: title.trim(),
          prompt: prompt.trim(),
          cadence,
          schedule: scheduleFor(),
          ...executionSettings,
        });
      }}
    >
      <h2 className="text-md-plus font-medium">
        {t(task ? "scheduled.edit" : "scheduled.create")}
      </h2>
      <Field label={t("nav.newTask")}>
        <Input
          required
          autoFocus
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={t("scheduled.prompt")}>
        <div className="composer-shell scheduled-instruction-shell">
          <Textarea
            required
            rows={4}
            className="composer-input scheduled-instruction-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("scheduled.promptPlaceholder")}
          />
          <ScheduledExecutionSettings
            workspacePath={workspacePath}
            projects={projects}
            permissionMode={permissionMode}
            modelSelection={modelSelection}
            sessionMode={sessionMode}
            busy={busy}
            onWorkspaceChange={(path) => {
              setWorkspacePath(path);
              setWorkspaceTouched(true);
            }}
            onPermissionChange={(mode) => {
              setPermissionMode(mode);
              setPermissionTouched(true);
            }}
            onModelChange={(selection) => {
              setModelSelection(selection);
              setModelTouched(true);
            }}
            onSessionModeChange={setSessionMode}
          />
        </div>
      </Field>
      {permissionMode === "auto" && (
        <p className="dest-row-meta scheduled-permission-warning" role="status">
          {t("scheduled.autoPermissionHint")}
        </p>
      )}

      {sessionMode === "reuse" && (
        <p className="dest-row-meta" role="status">
          {t("scheduled.sessionModeHint")}
        </p>
      )}
      <div className="scheduled-fields">
        <Field label={t("scheduled.cadence")}>
          <SettingsMenuSelect
            label={t("scheduled.cadence")}
            value={cadence}
            disabled={busy}
            options={cadences.map(([id, label]) => ({ id, label: t(label) }))}
            onChange={(value) => setCadence(value as ScheduledTask["cadence"])}
          />
        </Field>
        {cadence === "interval" && (
          <Field label={t("scheduled.interval")}>
            <div className="scheduled-interval">
              <Input
                type="number"
                inputMode="numeric"
                min={intervalFloor}
                max={intervalCeiling}
                step={1}
                disabled={busy}
                value={intervalValue}
                aria-label={t("scheduled.interval")}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
              <SettingsMenuSelect
                label={t("scheduled.interval")}
                value={intervalUnit}
                disabled={busy}
                options={[
                  { id: "minutes", label: t("scheduled.intervalUnitMinutes") },
                  { id: "hours", label: t("scheduled.intervalUnitHours") },
                ]}
                onChange={(unit) => switchIntervalUnit(unit === "hours" ? "hours" : "minutes")}
              />
            </div>
          </Field>
        )}
        {(cadence === "daily" || cadence === "weekly") && (
          <Field label={t("scheduled.time")}>
            <SettingsMenuSelect label={t("scheduled.time")} disabled={busy}
              value={period?.id ?? t("scheduled.customTime", { time: `${hour}:${minute}` })}
              options={periods.map(({ id, label }) => ({ id, label }))}
              onChange={(id) => {
                const next = periods.find((item) => item.id === id);
                if (next) { setHour(next.hour); setMinute("00"); }
              }} />
          </Field>
        )}
        {cadence === "weekly" && (
          <Field label={t("scheduled.weekday")}>
            <ScheduledWeekdaySelect value={weekdays} onChange={setWeekdays} disabled={busy} />
          </Field>
        )}
      </div>
      {(cadence === "daily" || cadence === "weekly") && (
        <p className="dest-row-meta">{hour}:{minute} · {t("scheduled.exactTimeHint")}</p>
      )}
      {cadence === "weekly" && (
        <p className="dest-row-meta" aria-live="polite">
          {t(weekdays.length ? "scheduled.weekdaysHint" : "scheduled.selectDay")}
        </p>
      )}
      {cadence === "hourly" && <p className="dest-row-meta">{t("scheduled.hourlyHint")}</p>}
      {cadence === "interval" && <p className="dest-row-meta">{t("scheduled.intervalHint")}</p>}
      <p className="dest-row-meta">{t("scheduled.localTimeHint")}</p>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {t("scheduled.save")}
        </Button>
        <Button type="button" disabled={busy} onClick={cancel}>
          {t("scheduled.cancel")}
        </Button>
      </div>
    </form>
  );
}
