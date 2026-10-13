import { Type } from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-desktop/shared";
import { toolResultText } from "./delegation-history.js";

export const taskListParameters = Type.Object({
  delegationId: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  after: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

export type TaskListArgs = { delegationId?: string; query?: string; after?: string; limit?: number };
type TraceEntry = {
  messageId: string;
  role: "assistant" | "tool";
  toolName?: string;
  status?: string;
  text: string;
  truncated: boolean;
};

/** Read existing transcript evidence; never replay child messages into the parent. */
export function delegationTrace(rows: readonly UiMessage[], args: TaskListArgs): {
  entries: TraceEntry[]; nextAfter?: string;
} {
  const limit = args.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("TaskList limit must be an integer from 1 to 20.");
  if (args.query !== undefined && (!args.query.trim() || args.query.length > 200)) throw new Error("TaskList query must contain 1 to 200 characters.");
  const start = args.after === undefined ? 0 : rows.findIndex((row) => row.id === args.after) + 1;
  if (args.after !== undefined && start === 0) throw new Error("TaskList cursor is not in this delegation. Restart without after.");
  const query = args.query?.toLowerCase();
  const entries: TraceEntry[] = [];
  let characters = 0;
  let nextAfter: string | undefined;
  for (const row of rows.slice(start)) {
    if (row.role !== "assistant" && row.role !== "tool") continue;
    // Deliberately omit thinking, images, attachments and arbitrary argument
    // payloads. Text results and visible assistant output are reusable evidence.
    const text = row.role === "tool" ? [row.toolName, toolResultText(row) ?? row.content].filter(Boolean).join("\n") : row.content;
    if (!text.trim()) continue;
    const match = query ? text.toLowerCase().indexOf(query) : 0;
    if (match < 0) continue;
    if (entries.length >= limit || characters >= 10_000) {
      nextAfter = entries.at(-1)?.messageId;
      break;
    }
    const offset = Math.max(0, match - 200);
    const excerpt = text.slice(offset, offset + Math.min(2_000, 10_000 - characters));
    characters += excerpt.length;
    entries.push({
      messageId: row.id, role: row.role,
      ...(row.toolName ? { toolName: row.toolName } : {}),
      ...(row.toolStatus ?? row.status ? { status: row.toolStatus ?? row.status } : {}),
      text: excerpt, truncated: offset > 0 || offset + excerpt.length < text.length,
    });
  }
  return { entries, ...(nextAfter ? { nextAfter } : {}) };
}
