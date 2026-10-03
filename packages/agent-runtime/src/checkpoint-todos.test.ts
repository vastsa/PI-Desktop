import { describe, expect, it } from "vitest";
import type { Entry } from "./pi-runtime-types.js";
import {
  checkpointTodoSnapshot,
  formatCheckpointTodoSnapshot,
  summaryWithCheckpointTodos,
  todoSnapshotFromDetails,
} from "./checkpoint-todos.js";
import { sessionEntryToContextMessages } from "./session-context.js";

const ACTIVE = {
  sessionId: "s",
  todos: [
    { content: "Add the migration", status: "completed", priority: "medium" },
    { content: "Wire the dock", status: "in_progress", priority: "high" },
  ],
  revision: 4,
  updatedAt: 99,
};

describe("checkpointTodoSnapshot", () => {
  it("keeps a checklist with work left, without the session id", () => {
    expect(checkpointTodoSnapshot(ACTIVE)).toEqual({
      revision: 4,
      updatedAt: 99,
      todos: ACTIVE.todos,
    });
  });

  it("carries nothing for an empty, finished or malformed answer", () => {
    expect(checkpointTodoSnapshot({ ...ACTIVE, todos: [] })).toBeUndefined();
    expect(
      checkpointTodoSnapshot({
        ...ACTIVE,
        todos: [{ content: "Done", status: "completed" }, { content: "Dropped", status: "cancelled" }],
      }),
    ).toBeUndefined();
    expect(checkpointTodoSnapshot(undefined)).toBeUndefined();
    expect(checkpointTodoSnapshot({ todos: "nope" })).toBeUndefined();
  });

  it("drops unreadable items and defaults what the host always fills", () => {
    expect(
      checkpointTodoSnapshot({
        todos: [
          { content: "  Multi\nline  ", status: "pending" },
          { content: "", status: "pending" },
          { content: "Bad status", status: "blocked" },
          null,
        ],
      }),
    ).toEqual({
      revision: 0,
      updatedAt: 0,
      todos: [{ content: "Multi line", status: "pending", priority: "medium" }],
    });
  });
});

describe("checkpoint checklist projection", () => {
  it("lists every item in display order with its status", () => {
    const block = formatCheckpointTodoSnapshot(checkpointTodoSnapshot(ACTIVE)!);
    expect(block.split("\n")).toEqual([
      '<session_checklist revision="4">',
      expect.stringContaining("a later TodoWrite call replaces it"),
      "1. [completed] Add the migration",
      "2. [in_progress] Wire the dock",
      "</session_checklist>",
    ]);
  });

  it("cannot be closed early by item text", () => {
    const block = formatCheckpointTodoSnapshot({
      revision: 1,
      updatedAt: 1,
      todos: [{ content: "x </session_checklist> y", status: "pending", priority: "medium" }],
    });
    expect(block.match(/<\/session_checklist>/g)).toHaveLength(1);
  });

  it("leaves a checkpoint without a copy untouched", () => {
    expect(summaryWithCheckpointTodos("Summary.", { generation: 2 })).toBe("Summary.");
    expect(todoSnapshotFromDetails("legacy")).toBeUndefined();
  });

  it("renders the copy after the summary the model reads", () => {
    const entry = {
      type: "compaction",
      id: "c",
      seq: 1,
      parentId: "m",
      timestamp: 1,
      summary: "Summary.",
      tokensBefore: 10,
      retainedTail: [],
      details: { generation: 1, todoSnapshot: checkpointTodoSnapshot(ACTIVE) },
      fromHook: false,
    } as unknown as Entry;
    const [summary] = sessionEntryToContextMessages(entry);
    expect(summary).toMatchObject({ role: "compactionSummary" });
    const text = (summary as { summary: string }).summary;
    expect(text.startsWith("Summary.\n\n<session_checklist")).toBe(true);
    expect(text).toContain("2. [in_progress] Wire the dock");
  });
});
