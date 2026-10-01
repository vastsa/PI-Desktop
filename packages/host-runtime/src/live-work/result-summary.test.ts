import { describe, expect, it } from "vitest";
import { findTurnResult, projectTurnResultSummary } from "./result-summary.js";

const item = (input: {
  id: string;
  turnId: string;
  role: string;
  content: string;
  createdAt: string;
  itemType?: "message" | "tool" | "compaction";
}) => ({
  id: input.id,
  turnId: input.turnId,
  itemType: input.itemType ?? "message",
  status: "completed" as const,
  createdAt: input.createdAt,
  content: { role: input.role, content: input.content },
});

describe("projectTurnResultSummary", () => {
  it("uses only the latest assistant message from the exact terminal turn", () => {
    const result = projectTurnResultSummary([
      item({ id: "old", turnId: "turn-1", role: "assistant", content: "Earlier reply.", createdAt: "2026-01-01T00:00:00Z" }),
      item({ id: "tool", turnId: "turn-1", role: "tool", content: "secret tool output", createdAt: "2026-01-01T00:00:02Z", itemType: "tool" }),
      item({ id: "new", turnId: "turn-1", role: "assistant", content: "Fixed the bug and ran its test.\n```text\nprivate log\n```", createdAt: "2026-01-01T00:00:03Z" }),
      item({ id: "later", turnId: "turn-2", role: "assistant", content: "A later unrelated turn.", createdAt: "2026-01-01T00:00:04Z" }),
    ], "turn-1", "completed");

    expect(result).toBe("Fixed the bug and ran its test.");
    expect(result).not.toContain("private log");
    expect(result).not.toContain("later unrelated");
  });

  it("uses an honest status fallback when no final assistant message exists", () => {
    expect(projectTurnResultSummary([], "turn-1", "completed")).toBe("Task completed. See the bound work session for details.");
    expect(projectTurnResultSummary([], "turn-1", "failed")).toContain("failed");
    expect(projectTurnResultSummary([], "turn-1", "interrupted")).toContain("interrupted");
    expect(projectTurnResultSummary([], "turn-1", "canceled")).toContain("canceled");
  });

  it("excludes child-agent and tool-associated assistant messages", () => {
    const child = {
      ...item({ id: "child", turnId: "turn-1", role: "assistant", content: "Child output", createdAt: "2026-01-01T00:00:04Z" }),
      agentName: "researcher",
    };
    const toolAssociated = {
      ...item({ id: "tool-child", turnId: "turn-1", role: "assistant", content: "Tool-linked output", createdAt: "2026-01-01T00:00:05Z" }),
      parentToolCallId: "tool-call-1",
    };
    const root = item({ id: "root", turnId: "turn-1", role: "assistant", content: "Root result", createdAt: "2026-01-01T00:00:03Z" });

    expect(findTurnResult([child, toolAssociated, root], "turn-1")).toEqual({
      text: "Root result",
      sourceMessageId: "root",
    });
  });

  it("bounds projected result text", () => {
    const result = projectTurnResultSummary([
      item({ id: "large", turnId: "turn-1", role: "assistant", content: "x".repeat(900), createdAt: "2026-01-01T00:00:00Z" }),
    ], "turn-1", "completed");
    expect(Array.from(result)).toHaveLength(480);
  });
});
