import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionTodo, TodoStatus } from "@pi-desktop/shared";
import { Button } from "./ui";
import { IconCheck, IconChevronDown, IconChevronUp } from "./icons";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";
import { useAppStore } from "../stores/app-store";

const VISIBLE_LIMIT = 8;

function statusSymbol(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return "◐";
    case "cancelled":
      return "⊘";
    default:
      return "○";
  }
}

export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  useSessionTodosRecovery(sessionId);
  if (!snapshot || snapshot.todos.length === 0) return null;
  const completed = snapshot.todos.filter((todo) => todo.status === "completed").length;
  const cancelled = snapshot.todos.filter((todo) => todo.status === "cancelled").length;
  const denominator = snapshot.todos.length - cancelled;
  const current = snapshot.todos.find((todo) => todo.status === "in_progress");
  const allCancelled = cancelled === snapshot.todos.length;
  const finished = snapshot.todos.every(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  );
  const visible = snapshot.todos.slice(0, VISIBLE_LIMIT);
  const remaining = Math.max(0, snapshot.todos.length - VISIBLE_LIMIT);
  const statusLabel = allCancelled
    ? t("chat.todo.status.cancelled")
    : finished
      ? t("chat.todo.completed", { completed, total: denominator })
      : current
        ? t("chat.todo.current", { completed, total: denominator, content: current.content })
        : t("chat.todo.progress", { completed, total: denominator });

  return (
    <div className={`todo-dock${expanded ? " is-expanded" : ""}`}>
      <Button
        type="button"
        variant="ghost"
        className="todo-dock-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="todo-dock-header-symbol" aria-hidden>
          {allCancelled ? "⊘" : finished ? "✓" : "◐"}
        </span>
        <span className="todo-dock-header-text">{statusLabel}</span>
        {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </Button>
      <div className="todo-dock-content" aria-hidden={!expanded}>
        <div className="todo-dock-list" role="list">
          {visible.map((todo, index) => (
            <TodoRow key={`${index}:${todo.content}`} todo={todo} />
          ))}
          {remaining > 0 ? (
            <div className="todo-dock-more" role="status">
              {t("chat.todo.more", { count: remaining })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TodoRow({ todo }: { todo: SessionTodo }) {
  const { t } = useTranslation();
  const label = t(`chat.todo.status.${todo.status}`);
  const completed = todo.status === "completed";
  return (
    <div className={`todo-dock-row todo-dock-row-${todo.status}`} role="listitem">
      <span className="todo-dock-row-symbol" role="img" aria-label={label} title={label}>
        {completed ? <IconCheck size={13} aria-hidden /> : statusSymbol(todo.status)}
      </span>
      <span className="todo-dock-row-content" title={todo.content}>
        {todo.content}
      </span>
    </div>
  );
}
