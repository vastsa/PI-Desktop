/**
 * The session checklist a compaction checkpoint carries for the model (#1177).
 *
 * Compaction summarizes the TodoWrite calls that kept the checklist current,
 * so after a checkpoint the model no longer sees which steps are done and
 * tends to rebuild a second list. The checkpoint therefore records one copy of
 * the host-owned checklist in its opaque `details`, and the context projection
 * renders it after the summary. The host table stays the only authority: the
 * copy is never read back by the UI, and a later TodoWrite supersedes it.
 */

import type { SessionTodo, TodoStatus } from "@pi-desktop/shared";

export type CheckpointTodoSnapshot = {
  revision: number;
  updatedAt: number;
  todos: SessionTodo[];
};

const STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTodo(value: unknown): SessionTodo | undefined {
  if (!isRecord(value)) return undefined;
  const content =
    typeof value.content === "string"
      ? value.content.replace(/\s+/g, " ").trim()
      : "";
  const status = STATUSES.find((candidate) => candidate === value.status);
  if (!content || !status) return undefined;
  const priority =
    value.priority === "high" || value.priority === "low"
      ? value.priority
      : "medium";
  return { content, status, priority };
}

/**
 * Read a `todos.get` answer, or a stored copy of one, without trusting its
 * shape. Only a list with work left is worth carrying: an empty or finished
 * checklist gives the model nothing to resume.
 */
export function checkpointTodoSnapshot(
  value: unknown,
): CheckpointTodoSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.todos)) return undefined;
  const todos = value.todos.flatMap((todo) => parseTodo(todo) ?? []);
  if (
    !todos.some(
      (todo) => todo.status === "pending" || todo.status === "in_progress",
    )
  ) {
    return undefined;
  }
  return {
    revision:
      typeof value.revision === "number" && Number.isFinite(value.revision)
        ? value.revision
        : 0,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : 0,
    todos,
  };
}

export function todoSnapshotFromDetails(
  details: unknown,
): CheckpointTodoSnapshot | undefined {
  return isRecord(details)
    ? checkpointTodoSnapshot(details.todoSnapshot)
    : undefined;
}

const CLOSE_TAG = "</session_checklist>";

/** The block the model reads after a checkpoint summary. */
export function formatCheckpointTodoSnapshot(
  snapshot: CheckpointTodoSnapshot,
): string {
  return [
    `<session_checklist revision="${snapshot.revision}">`,
    "Your TodoWrite checklist as it stood when this conversation was compacted. Continue from it instead of starting a new list; a later TodoWrite call replaces it, and every call must still resend all items.",
    ...snapshot.todos.map(
      (todo, index) =>
        `${index + 1}. [${todo.status}] ${todo.content.replaceAll(CLOSE_TAG, "")}`,
    ),
    CLOSE_TAG,
  ].join("\n");
}

/** The summary text the model sees for a checkpoint, checklist included. */
export function summaryWithCheckpointTodos(
  summary: string,
  details: unknown,
): string {
  const snapshot = todoSnapshotFromDetails(details);
  if (!snapshot) return summary;
  const block = formatCheckpointTodoSnapshot(snapshot);
  return summary.trim() ? `${summary}\n\n${block}` : block;
}
