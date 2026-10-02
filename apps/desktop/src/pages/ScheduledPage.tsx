import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTask } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { Button, Panel } from "../components/ui";
import { IconClock } from "../components/icons";
import { ScheduledEditor, type ScheduledDraft } from "../features/scheduled/ScheduledEditor";
import { ScheduledTaskDetail } from "../features/scheduled/ScheduledTaskDetail";
import { ScheduledTaskRail } from "../features/scheduled/ScheduledTaskRail";
import { useScheduledWorkspace } from "../features/scheduled/use-scheduled-workspace";
import { rememberScheduledReturn } from "../features/scheduled/scheduled-return";
import "../features/scheduled/scheduled-workspace.css";

/**
 * Scheduled workspace: a task column and the selected task's page. Each task
 * reports its own last outcome and next occurrence, its runs are readable in
 * place, and the conversation stays one explicit action away — the automation's
 * transcripts live here rather than in the sidebar's project groups.
 */
export function ScheduledPage() {
  const { t, i18n } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const selectSession = useAppStore((s) => s.selectSession);
  const setPage = useAppStore((s) => s.setPage);
  const currentWorkspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const providers = useAppStore((s) => s.providers);
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const workspace = useScheduledWorkspace((message) => showToast(message, { variant: "error" }));
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { tasks, projects, selectedTask, selectedTaskId, runs, latestRuns, selectedRunId, busy, loaded, error } =
    workspace;

  // Remember where the reader came from: the conversation offers the way back,
  // and this page restores the same task and the same run.
  const openSession = async (sessionId: string, runId: string) => {
    if (selectedTask) {
      rememberScheduledReturn({
        taskId: selectedTask.id,
        taskTitle: selectedTask.title,
        runId,
        sessionId,
      });
    }
    await selectSession(sessionId);
    setPage("chat");
  };
  const save = async (draft: ScheduledDraft) => {
    const saved = await workspace.saveTask(editor && editor !== "new" ? editor.id : null, draft);
    if (saved) setEditor(null);
  };
  const remove = (task: ScheduledTask) => {
    if (!window.confirm(t("scheduled.deleteConfirm", { title: task.title }))) return;
    if (editor && editor !== "new" && editor.id === task.id) setEditor(null);
    void workspace.deleteTask(task.id);
  };
  // Relative labels are recomputed on every render, and the poll re-renders at
  // least every ten seconds, so a row never reports a stale "in 2 minutes".
  const now = Date.now();

  return (
    <div className="route-scroll">
      <div className="page-frame scheduled-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("scheduled.title")}</h1>
            <p className="dest-row-meta">{t("scheduled.description")}</p>
          </div>
          <Button variant="primary" disabled={busy} onClick={() => setEditor("new")}>
            {t("scheduled.create")}
          </Button>
        </div>

        {error && (
          <Panel className="scheduled-error">
            <p role="alert">{error}</p>
            <Button onClick={() => void workspace.refresh()}>{t("scheduled.retry")}</Button>
          </Panel>
        )}
        {!loaded && !error && <p role="status">{t("common.loading")}</p>}

        {editor && (
          <div className="scheduled-editor-slot">
            <ScheduledEditor
              key={editor === "new" ? "new" : editor.id}
              task={editor === "new" ? undefined : editor}
              projects={projects}
              currentWorkspacePath={currentWorkspacePath}
              busy={busy}
              save={save}
              cancel={() => setEditor(null)}
            />
          </div>
        )}

        {loaded && tasks.length === 0 && !editor ? (
          <Panel className="page-card page-empty">
            <div className="page-empty-icon">
              <IconClock size={20} />
            </div>
            <h2>{t("scheduled.emptyTitle")}</h2>
            <p className="dest-row-meta">{t("scheduled.description")}</p>
          </Panel>
        ) : null}

        {/* The form owns the page while it is open: the task column and the
            selected task's page would only compete with the draft. */}
        {loaded && tasks.length > 0 && !editor ? (
          <div className="scheduled-workspace">
            <ScheduledTaskRail
              tasks={tasks}
              latestRuns={latestRuns}
              selectedTaskId={selectedTaskId}
              now={now}
              locale={locale}
              onSelect={workspace.selectTask}
            />
            {selectedTask ? (
              <ScheduledTaskDetail
                task={selectedTask}
                runs={runs}
                selectedRunId={selectedRunId}
                running={workspace.taskIsRunning(selectedTask.id)}
                busy={busy}
                now={now}
                locale={locale}
                onSelectRun={workspace.selectRun}
                onOpenSession={(sessionId, runId) => void openSession(sessionId, runId)}
                onRunNow={() => void workspace.runTaskNow(selectedTask.id)}
                onEdit={() => setEditor(selectedTask)}
                onToggleEnabled={() =>
                  void workspace.toggleTask(selectedTask.id, !selectedTask.enabled)
                }
                onDelete={() => remove(selectedTask)}
                providerName={
                  providers.find((item) => item.id === selectedTask.providerId)?.name ?? null
                }
              />
            ) : (
              <Panel className="page-card page-empty">
                <p className="dest-row-meta">{t("scheduled.selectTask")}</p>
              </Panel>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
