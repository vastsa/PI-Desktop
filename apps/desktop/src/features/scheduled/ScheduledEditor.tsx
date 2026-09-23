import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GlobalPermissionMode, ProjectRecord, ScheduledTask } from "@pi-desktop/shared";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { ScheduledWeekdaySelect } from "./ScheduledWeekdaySelect";
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
    (cadence !== "weekly" || weekdays.length > 0);
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
    ["daily", "scheduled.cadenceDaily"],
    ["weekly", "scheduled.cadenceWeekly"],
  ] as const;
  return (
    <form
      className="dest-create space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !valid) return;
        const executionSettings: Pick<
          ScheduledDraft,
          "workspacePath" | "permissionMode" | "providerId" | "modelId" | "thinkingLevel"
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
        void save({
          title: title.trim(),
          prompt: prompt.trim(),
          cadence,
          schedule:
            cadence === "manual"
              ? null
              : cadence === "hourly"
                ? { hour: 0, minute: 0, weekday: 0 }
                : {
                    hour: Number(hour), minute: Number(minute), weekday: weekdays[0] ?? 0,
                    ...(cadence === "weekly" ? { weekdays } : {}),
                  },
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
          />
        </div>
      </Field>
      {permissionMode === "auto" && (
        <p className="dest-row-meta scheduled-permission-warning" role="status">
          {t("scheduled.autoPermissionHint")}
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
