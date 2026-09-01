import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTask } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Badge, Button, Field, Input, Panel, Select, Textarea } from "../components/ui";
import { IconClock } from "../components/icons";

export function ScheduledPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const selectSession = useAppStore((s) => s.selectSession);
  const setPage = useAppStore((s) => s.setPage);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<ScheduledTask["cadence"]>("manual");
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.listScheduled();
      setTasks(res.tasks || []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const cadenceLabel = (value: ScheduledTask["cadence"]) => {
    if (value === "hourly") return t("scheduled.cadenceHourly");
    if (value === "daily") return t("scheduled.cadenceDaily");
    if (value === "weekly") return t("scheduled.cadenceWeekly");
    return t("scheduled.cadenceManual");
  };

  return (
    <div className="thread-scroll">
      <div className="page-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("scheduled.title")}</h1>
          </div>
        </div>

        <div className="dest-create space-y-3">
          <div className="text-md-plus font-medium">{t("scheduled.create")}</div>
          <Field label={t("nav.newTask")}>
            <Input
              value={title}
              placeholder={t("chat.untitledTask")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label={t("scheduled.prompt")}>
            <Textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("scheduled.promptPlaceholder")}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <Field label={t("scheduled.cadence")}>
                <Select
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as ScheduledTask["cadence"])}
                >
                  <option value="manual">{t("scheduled.cadenceManual")}</option>
                  <option value="hourly">{t("scheduled.cadenceHourly")}</option>
                  <option value="daily">{t("scheduled.cadenceDaily")}</option>
                  <option value="weekly">{t("scheduled.cadenceWeekly")}</option>
                </Select>
              </Field>
            </div>
            <Button
              variant="primary"
              disabled={loading || !prompt.trim()}
              onClick={async () => {
                try {
                  await api.createScheduled({
                    title: title.trim() || t("chat.untitledTask"),
                    prompt: prompt.trim(),
                    cadence,
                    enabled: true,
                  });
                  setTitle("");
                  setPrompt("");
                  setCadence("manual");
                  await refresh();
                  showToast(t("scheduled.create"), { variant: "success" });
                } catch (e) {
                  showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
                }
              }}
            >
              {t("scheduled.create")}
            </Button>
          </div>
        </div>

        <div className="dest-section-label">{t("scheduled.tasks")}</div>

        {tasks.length === 0 ? (
          <Panel className="page-card page-empty">
            <div className="page-empty-icon">
              <IconClock size={20} />
            </div>
            <div className="text-base-plus font-medium">{t("scheduled.emptyTitle")}</div>
          </Panel>
        ) : (
          <div className="dest-list">
            {tasks.map((task) => (
              <div key={task.id} className="dest-row">
                <div className="dest-row-icon">
                  <IconClock size={16} />
                </div>
                <div className="dest-row-body">
                  <div className="dest-row-title">
                    <span className="min-w-0 truncate">{task.title}</span>
                    <Badge tone={task.enabled ? "success" : "neutral"}>
                      {task.enabled ? t("scheduled.enabled") : t("scheduled.disabled")}
                    </Badge>
                    <Badge tone="neutral">{cadenceLabel(task.cadence)}</Badge>
                  </div>
                  <div className="dest-row-meta line-clamp-2">{task.prompt}</div>
                  <div className="dest-row-meta">
                    {t("scheduled.lastRun")}:{" "}
                    {task.lastRunAt
                      ? new Date(task.lastRunAt).toLocaleString()
                      : t("scheduled.never")}
                  </div>
                </div>
                <div className="dest-row-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={async () => {
                      try {
                        const res = await api.runScheduled(task.id);
                        await selectSession(res.sessionId);
                        setPage("chat");
                        await sendPrompt(res.prompt);
                        await refresh();
                      } catch (e) {
                        showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
                      }
                    }}
                  >
                    {t("scheduled.runNow")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await api.updateScheduled({
                        id: task.id,
                        enabled: !task.enabled,
                      });
                      await refresh();
                    }}
                  >
                    {task.enabled ? t("scheduled.disabled") : t("scheduled.enabled")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.deleteScheduled(task.id);
                      await refresh();
                    }}
                  >
                    {t("scheduled.delete")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
