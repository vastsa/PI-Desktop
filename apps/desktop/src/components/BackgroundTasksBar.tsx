import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { BackgroundTaskOutput } from "../lib/api";
import { useBackgroundTasks } from "../features/chat/background-tasks/useBackgroundTasks";
import { Button } from "./ui";

/** Characters shown when a finished task produced no output at all. */
const NO_OUTPUT = "—";

/**
 * Shows chat-started background commands (dev servers, watchers) above the
 * composer. The lifecycle lives in host-core — a task survives turn aborts
 * and renderer reloads; this bar only reflects registry state and can stop a
 * task on request.
 *
 * Only work that is still running, or that the renderer just watched finish,
 * earns a row here: a command that ended long ago is history, not something
 * the user is waiting on, and it must not sit above the composer forever.
 * Running tasks float to the top.
 */
export function BackgroundTasksBar(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { tasks, expandedId, output, stoppingIds, error, toggleOutput, stop, dismiss } =
    useBackgroundTasks();
  const outputText = useMemo(
    () => formatOutput(output, expandedId ?? ""),
    [output, expandedId],
  );
  if (tasks.length === 0 && !error) return null;

  return (
    <div
      className="background-tasks-bar"
      role="region"
      aria-label={t("backgroundTasks.title")}
      tabIndex={0}
    >
      {error ? (
        <p className="background-task-error" role="alert">
          {t(`backgroundTasks.${error}Failed`)}
        </p>
      ) : null}
      {tasks.map((task) => {
        const isRunning = task.state === "running";
        const stopping = stoppingIds.has(task.id);
        return (
          <div
            key={task.id}
            className="background-task"
            data-state={task.state}
          >
            <span
              className="background-task-state"
              data-state={task.state}
              title={t(`backgroundTasks.${task.state}`)}
            />
            <span className="background-task-command" title={task.command}>
              {task.command}
            </span>
            <span className="background-task-meta">
              {t(`backgroundTasks.${task.state}`)}
              {isRunning ? ` · ${formatElapsed(task.elapsedMs)}` : ""}
              {task.exitCode !== undefined ? ` · ${task.exitCode}` : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="background-task-action"
              onClick={() => void toggleOutput(task.id)}
              aria-expanded={expandedId === task.id}
            >
              {t("backgroundTasks.output")}
            </Button>
            {isRunning ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="background-task-action is-stop"
                onClick={() => void stop(task.id)}
                disabled={stopping}
              >
                {stopping ? t("backgroundTasks.stopping") : t("backgroundTasks.stop")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="background-task-action"
                onClick={() => dismiss(task.id)}
              >
                {t("backgroundTasks.dismiss")}
              </Button>
            )}
            {expandedId === task.id ? (
              <pre className="background-task-output">
                {outputText || NO_OUTPUT}
              </pre>
            ) : null}
          </div>
        );
      })}
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

function formatOutput(
  output: BackgroundTaskOutput | null,
  id: string,
): string {
  if (!output || output.id !== id) return "";
  const tail = (text: string, limit: number) =>
    text.length > limit ? `…${text.slice(-limit)}` : text;
  return [tail(output.stdout, 8000), tail(output.stderr, 4000)]
    .filter((part) => part.length > 0)
    .join("\n---\n")
    .trim();
}
