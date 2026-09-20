import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Badge, Button, Panel } from "../components/ui";
import { IconClock } from "../components/icons";
import { ScheduledEditor, type ScheduledDraft } from "../features/scheduled/ScheduledEditor";

export function ScheduledPage() {
  const { t, i18n } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const selectSession = useAppStore((s) => s.selectSession);
  const setPage = useAppStore((s) => s.setPage);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [tab, setTab] = useState<"tasks" | "runs">("tasks");
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const [taskResult, runResult] = await Promise.all([
        api.listScheduled(),
        api.listScheduledRuns(),
      ]);
      if (!mounted.current || request !== revision.current) return;
      setTasks(taskResult.tasks);
      setRuns(runResult.runs);
      setError("");
      setLoaded(true);
    } catch (failure) {
      if (mounted.current && request === revision.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      mounted.current = false;
      revision.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      if (mounted.current) await refresh();
    } catch (failure) {
      showToast(failure instanceof Error ? failure.message : String(failure), { variant: "error" });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const save = (draft: ScheduledDraft) =>
    action(async () => {
      if (editor && editor !== "new") await api.updateScheduled({ id: editor.id, ...draft });
      else await api.createScheduled(draft);
      if (mounted.current) setEditor(null);
    });
  const openSession = async (id: string) => {
    await selectSession(id);
    if (mounted.current) setPage("chat");
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language);
  const cadenceKey = {
    manual: "scheduled.cadenceManual",
    hourly: "scheduled.cadenceHourly",
    daily: "scheduled.cadenceDaily",
    weekly: "scheduled.cadenceWeekly",
  } as const;
  const statusKey = {
    running: "scheduled.statusRunning",
    completed: "scheduled.statusCompleted",
    aborted: "scheduled.statusAborted",
    error: "scheduled.statusError",
  } as const;
  return (
    <div className="thread-scroll">
      <div className="page-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("scheduled.title")}</h1>
            <p className="dest-row-meta">{t("scheduled.description")}</p>
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setTab("tasks");
              setEditor("new");
            }}
          >
            {t("scheduled.create")}
          </Button>
        </div>
        <div className="mb-4 flex gap-2" role="group" aria-label={t("scheduled.title")}>
          <Button
            aria-pressed={tab === "tasks"}
            variant={tab === "tasks" ? "secondary" : "ghost"}
            onClick={() => setTab("tasks")}
          >
            {t("scheduled.tasks")} ({tasks.length})
          </Button>
          <Button
            aria-pressed={tab === "runs"}
            variant={tab === "runs" ? "secondary" : "ghost"}
            onClick={() => setTab("runs")}
          >
            {t("scheduled.runs")}
          </Button>
        </div>
        {error && (
          <Panel>
            <p role="alert">{error}</p>
            <Button onClick={() => void refresh()}>{t("scheduled.retry")}</Button>
          </Panel>
        )}
        {!loaded && !error && <p role="status">{t("common.loading")}</p>}
        {tab === "tasks" && (
          <>
            {editor && (
              <ScheduledEditor
                key={editor === "new" ? "new" : editor.id}
                task={editor === "new" ? undefined : editor}
                busy={busy}
                save={save}
                cancel={() => setEditor(null)}
              />
            )}
            {loaded && !tasks.length && !editor && (
              <Panel className="page-card page-empty">
                <div className="page-empty-icon">
                  <IconClock size={20} />
                </div>
                <h2>{t("scheduled.emptyTitle")}</h2>
                <p className="dest-row-meta">{t("scheduled.description")}</p>
              </Panel>
            )}
            <div className="dest-list">
              {tasks.map((task) => {
                const running = runs.some(
                  (run) => run.taskId === task.id && run.status === "running",
                );
                return (
                  <div className="dest-row" key={task.id}>
                    <div className="dest-row-icon">
                      <IconClock size={16} />
                    </div>
                    <div className="dest-row-body">
                      <div className="dest-row-title">
                        <span>{task.title}</span>
                        <Badge tone={task.enabled ? "success" : "neutral"}>
                          {t(task.enabled ? "scheduled.enabled" : "scheduled.disabled")}
                        </Badge>
                        <Badge tone="neutral">{t(cadenceKey[task.cadence])}</Badge>
                      </div>
                      <p className="dest-row-meta line-clamp-2">{task.prompt}</p>
                      <p className="dest-row-meta">
                        {task.schedule && task.enabled && task.nextRunAt
                          ? `${t("scheduled.nextRun")}: ${date(task.nextRunAt)}`
                          : t(
                              task.enabled && task.cadence !== "manual" && !task.schedule
                                ? "scheduled.legacyHint"
                                : "scheduled.noNextRun",
                            )}
                      </p>
                      {task.workspacePath && (
                        <p className="dest-row-meta truncate">{task.workspacePath}</p>
                      )}
                    </div>
                    <div className="dest-row-actions flex-wrap">
                      <Button
                        size="sm"
                        disabled={busy || running}
                        onClick={() =>
                          void action(async () => {
                            await api.executeScheduled(task.id);
                            if (mounted.current) setTab("runs");
                          })
                        }
                      >
                        {t(running ? "scheduled.statusRunning" : "scheduled.runNow")}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => setEditor(task)}>
                        {t("scheduled.edit")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api.updateScheduled({ id: task.id, enabled: !task.enabled });
                          })
                        }
                      >
                        {t(task.enabled ? "scheduled.pause" : "scheduled.resume")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || running}
                        onClick={() => {
                          if (window.confirm(t("scheduled.deleteConfirm", { title: task.title })))
                            void action(async () => {
                              await api.deleteScheduled(task.id);
                            });
                        }}
                      >
                        {t("scheduled.delete")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {tab === "runs" && (
          <>
            <p className="dest-row-meta mb-3">{t("scheduled.historyHint")}</p>
            {!runs.length && loaded && (
              <Panel className="page-card page-empty">{t("scheduled.emptyRuns")}</Panel>
            )}
            <div className="dest-list">
              {runs.map((run) => (
                <div className="dest-row" key={run.id}>
                  <div className="dest-row-body">
                    <div className="dest-row-title">
                      <span>
                        {tasks.find((task) => task.id === run.taskId)?.title ??
                          t("scheduled.title")}
                      </span>
                      <Badge tone={run.status === "completed" ? "success" : "neutral"}>
                        {t(statusKey[run.status])}
                      </Badge>
                    </div>
                    <p className="dest-row-meta">{date(run.startedAt)}</p>
                    {run.errorCode && (
                      <p className="dest-row-meta">
                        {t("scheduled.runError")} ({run.errorCode})
                      </p>
                    )}
                  </div>
                  {run.sessionId && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void action(() => openSession(run.sessionId!))}
                    >
                      {t("scheduled.openResult")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
