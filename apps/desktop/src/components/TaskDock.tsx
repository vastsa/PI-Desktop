import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionTodo } from "@pi-desktop/shared";
import type { BackgroundTaskOutput, BackgroundTaskSummary } from "../lib/api";
import { Button } from "./ui";
import { IconChevronDown, IconChevronUp } from "./icons";
import { TodoPanel, todoProgress } from "./TodoDock";
import { useAppStore } from "../stores/app-store";
import { useBackgroundTasks } from "../features/chat/background-tasks/useBackgroundTasks";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";

/**
 * The composer's shared Todo + background-task container.
 *
 * Layout: one container, one header. The header carries the progress summary, a
 * live count, the tab list and the chevron; collapsing hides only the panels, so
 * the tabs stay reachable while collapsed. A single tab whose side is empty is
 * not rendered, and a container with nothing to show renders nothing at all.
 *
 * The container owns the disclosure and the tab choice; the panels only render
 * rows. Filtering, removal and the badge all live in the hook, so this file stays
 * presentational.
 */
export function TaskDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const panelId = useId();

  // The container now owns the todo read, so it recovers the snapshot the same
  // way the standalone dock did.
  useSessionTodosRecovery(sessionId);

  const todos = snapshot?.todos ?? [];
  const hasTodo = todos.length > 0;

  const progress = useMemo(
    () => (hasTodo ? todoProgress(todos, t) : null),
    [hasTodo, todos, t],
  );

  // The container owns the todo read, so it hands the hook the todo side it
  // cannot read itself: one tab rule then decides both the visible panel and
  // whether a new task needs a badge.
  const {
    tasks,
    sessionTasks,
    activeTab,
    openTasksTab,
    openTodoTab,
    collapsed,
    setCollapsed,
    badge,
    badgeText,
    expandedId,
    output,
    toggleOutput,
    stop,
    remove,
    error,
    stoppingIds,
  } = useBackgroundTasks(sessionId, todos);

  const hasTasks = sessionTasks.length > 0;
  const running = sessionTasks.filter((task) => task.state === "running").length;
  const showTabs = hasTodo && hasTasks;

  if (!hasTodo && !hasTasks && !error) return null;

  // A remembered tab that lost its content falls back to the other side.
  const tab = hasTodo && hasTasks
    ? activeTab
    : hasTasks
      ? "tasks"
      : "todo";

  const headerText = progress
    ? progress.label
    : t("backgroundTasks.headerCount", { count: sessionTasks.length });

  return (
    <div className={`dock${collapsed ? "" : " is-expanded"}`}>
      <div className="dock-header">
        <button
          type="button"
          className="dock-header-main"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          aria-label={
            collapsed
              ? t("taskDock.expand", { label: headerText })
              : t("taskDock.collapse", { label: headerText })
          }
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="dock-header-symbol" aria-hidden>
            {progress ? progress.symbol : "\u25d0"}
          </span>
          <span className="dock-header-copy">
            <span className="dock-header-text">{headerText}</span>
            {progress?.current ? (
              <span
                className={`dock-header-current${collapsed ? " todo-dock-shimmer" : ""}`}
                title={progress.current.content}
              >
                {progress.current.content}
              </span>
            ) : null}
          </span>
          {running > 0 ? (
            <span className="dock-live">
              <span className="dock-live-dot" aria-hidden />
              <span className="dock-live-label">
                {t("taskDock.runningCount", { count: running })}
              </span>
            </span>
          ) : null}
        </button>

        {showTabs ? (
          <div className="dock-tablist is-inline" role="tablist" aria-label={t("taskDock.title")}>
            <button
              type="button"
              role="tab"
              id={`${panelId}-todo-tab`}
              aria-controls={`${panelId}-todo`}
              aria-selected={tab === "todo"}
              tabIndex={tab === "todo" ? 0 : -1}
              className={`dock-tab${tab === "todo" ? " is-active" : ""}`}
              onClick={openTodoTab}
            >
              {t("taskDock.tabTodo")}
            </button>
            <button
              type="button"
              role="tab"
              id={`${panelId}-tasks-tab`}
              aria-controls={`${panelId}-tasks`}
              aria-selected={tab === "tasks"}
              tabIndex={tab === "tasks" ? 0 : -1}
              className={`dock-tab${tab === "tasks" ? " is-active" : ""}`}
              onClick={openTasksTab}
            >
              {t("taskDock.tabTasks")}
              {badge > 0 ? (
                <span
                  className="dock-tab-badge"
                  aria-label={t("taskDock.newTasks", { count: badge })}
                >
                  {badgeText}
                </span>
              ) : null}
            </button>
          </div>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          className="dock-toggle"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          aria-label={
            collapsed
              ? t("taskDock.expand", { label: headerText })
              : t("taskDock.collapse", { label: headerText })
          }
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </Button>
      </div>

      <div id={panelId} className="dock-content" aria-hidden={collapsed}>
        <div className="dock-clip">
          {error ? (
            <p className="background-task-error" role="alert">
              {t(`backgroundTasks.${error === "remove" ? "removeFailed" : `${error}Failed`}`)}
            </p>
          ) : null}
          {hasTodo ? (
            <TodoPanel
              todos={todos}
              listId={`${panelId}-todo`}
              interactive={!collapsed && tab === "todo"}
            />
          ) : null}
          {hasTasks ? (
            <TaskPanel
              listId={`${panelId}-tasks`}
              tasks={tasks}
              expandedId={expandedId}
              output={output}
              stoppingIds={stoppingIds}
              onToggleOutput={toggleOutput}
              onStop={(id) => void stop(id)}
              onRemove={remove}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Task rows. `Output` and `Stop`/`Remove` sit outside the row body so the
 * clickable band never swallows a control, and the whole row stays one line:
 * a long command ellipsizes with its full text in `title`.
 */
function TaskPanel({
  listId,
  tasks,
  expandedId,
  output,
  stoppingIds,
  onToggleOutput,
  onStop,
  onRemove,
}: {
  listId: string;
  tasks: readonly BackgroundTaskSummary[];
  expandedId: string | null;
  output: BackgroundTaskOutput | null;
  stoppingIds: ReadonlySet<string>;
  onToggleOutput: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => boolean;
}) {
  const { t } = useTranslation();
  return (
    <div id={listId} className="dock-panel" role="tabpanel" aria-labelledby={`${listId}-tab`}>
      <div className="task-list">
        {tasks.map((task) => {
          const running = task.state === "running";
          const stopping = stoppingIds.has(task.id);
          const expanded = expandedId === task.id;
          const meta = [
            t(`backgroundTasks.${task.state}`),
            running ? formatElapsed(task.elapsedMs) : null,
            task.exitCode !== undefined ? String(task.exitCode) : null,
          ].filter(Boolean).join(" \u00b7 ");
          return (
            <div
              key={task.id}
              className="task-row"
              data-state={task.state}
              data-expanded={expanded ? "true" : undefined}
            >
              <div className="task-band">
                <div
                  className="task-main"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => onToggleOutput(task.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggleOutput(task.id);
                    }
                  }}
                >
                  <span className="task-state" aria-hidden />
                  <span className="task-command" title={task.command}>{task.command}</span>
                  <span className="task-meta">{meta}</span>
                </div>
                {running ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="task-action is-stop"
                    onClick={() => onStop(task.id)}
                    disabled={stopping}
                  >
                    {stopping ? t("backgroundTasks.stopping") : t("backgroundTasks.stop")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="task-action"
                    onClick={() => onRemove(task.id)}
                  >
                    {t("backgroundTasks.dismiss")}
                  </Button>
                )}
              </div>
              {expanded ? (
                <pre className="task-output">{formatOutput(output, task.id)}</pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Characters shown when a finished task produced no output at all. */
const NO_OUTPUT = "\u2014";

function formatOutput(output: BackgroundTaskOutput | null, id: string): string {
  if (!output || output.id !== id) return "";
  const tail = (text: string, limit: number) =>
    text.length > limit ? `\u2026${text.slice(-limit)}` : text;
  return [tail(output.stdout, 8000), tail(output.stderr, 4000)]
    .filter((part) => part.length > 0)
    .join("\n---\n")
    .trim() || NO_OUTPUT;
}

export type { SessionTodo };
