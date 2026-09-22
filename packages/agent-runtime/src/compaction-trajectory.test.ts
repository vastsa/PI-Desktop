import { describe, expect, it } from "vitest";
import {
  TRAJECTORY_MAX_GOAL_CHARS,
  TRAJECTORY_MAX_NEXT_STEPS,
  TRAJECTORY_MAX_OPEN_ITEMS,
  buildTrajectorySummary,
  extractGoal,
  extractNextSteps,
  extractOpenItems,
  type TrajectoryMessage,
} from "./compaction-trajectory.js";

/**
 * The property that makes a trajectory checkpoint a real summary rather than a
 * note: the same minimum length and section headings the runtime's own summary
 * check enforces, so the next summarization request can carry it forward like
 * any other summary instead of being a special case.
 */
const REQUIRED_SECTIONS = ["## Goal", "## Progress", "## Next Steps"] as const;

function carryableAsSummary(text: string): boolean {
  if (text.trim().length < 200) return false;
  return REQUIRED_SECTIONS.every((section) =>
    new RegExp(`^${section}\\s*$`, "m").test(text),
  );
}

function user(text: string): TrajectoryMessage {
  return { role: "user", content: text };
}

function assistant(
  text: string,
  calls: Array<{ id?: string; name: string; arguments?: unknown }> = [],
): TrajectoryMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((call) => ({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    ],
  };
}

function failure(
  toolName: string,
  text: string,
  toolCallId?: string,
): TrajectoryMessage {
  return {
    role: "toolResult",
    toolName,
    isError: true,
    toolCallId,
    content: [{ type: "text", text }],
  };
}

describe("extractGoal", () => {
  it("takes the last user request verbatim", () => {
    expect(
      extractGoal([user("first ask"), user("second ask")]),
    ).toBe("second ask");
  });

  it("ignores an empty or non-text user message", () => {
    expect(extractGoal([user("real ask"), user("   ")])).toBe("real ask");
    expect(extractGoal([{ role: "user" }])).toBeUndefined();
  });

  it("bounds a goal that would dominate the checkpoint", () => {
    const goal = extractGoal([user("x".repeat(TRAJECTORY_MAX_GOAL_CHARS + 50))]);
    expect(goal?.length).toBe(TRAJECTORY_MAX_GOAL_CHARS + 1);
    expect(goal?.endsWith("…")).toBe(true);
  });

  it("returns undefined when the range holds no user request", () => {
    expect(extractGoal([assistant("done")])).toBeUndefined();
  });
});

describe("extractOpenItems", () => {
  it("names a failure nothing repaired", () => {
    expect(
      extractOpenItems([
        assistant("", [{ id: "call-1", name: "Bash", arguments: { command: "x" } }]),
        failure("Bash", "command failed: exit 1", "call-1"),
      ]),
    ).toEqual(["Bash: command failed: exit 1"]);
  });

  it("drops a failure a later edit to the same file repaired", () => {
    expect(
      extractOpenItems([
        assistant("", [{ id: "read-1", name: "Read", arguments: { file_path: "a.ts" } }]),
        failure("Read", "file not found", "read-1"),
        assistant("", [{ id: "write-1", name: "Write", arguments: { file_path: "a.ts" } }]),
        // The repair has to have landed: a Write that never returned, or one
        // that failed, is not evidence that the file became readable.
        {
          role: "toolResult",
          toolName: "Write",
          isError: false,
          toolCallId: "write-1",
          content: [{ type: "text", text: "written" }],
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a failure whose repair came before it", () => {
    // The edit belongs to earlier work; the failure happened afterwards and is
    // still unexplained, which is exactly what a next window needs to know.
    expect(
      extractOpenItems([
        assistant("", [{ id: "write-1", name: "Write", arguments: { file_path: "a.ts" } }]),
        assistant("", [{ id: "read-1", name: "Read", arguments: { file_path: "a.ts" } }]),
        failure("Read", "file not found", "read-1"),
      ]),
    ).toEqual(["Read: file not found"]);
  });

  it("keeps a failure it cannot attribute to a path", () => {
    expect(
      extractOpenItems([failure("Bash", "npm test failed", "unknown-call")]),
    ).toEqual(["Bash: npm test failed"]);
  });

  it("takes only the first line and bounds the list", () => {
    const items = extractOpenItems([
      failure("Bash", "first line\nsecond line"),
      ...Array.from({ length: TRAJECTORY_MAX_OPEN_ITEMS + 3 }, (_, index) =>
        failure("Bash", `failure ${index}`),
      ),
    ]);
    expect(items[0]).toBe("Bash: first line");
    expect(items).toHaveLength(TRAJECTORY_MAX_OPEN_ITEMS);
  });

  it("does not repeat an identical failure", () => {
    expect(
      extractOpenItems([failure("Bash", "same"), failure("Bash", "same")]),
    ).toEqual(["Bash: same"]);
  });

  it("ignores a result that succeeded", () => {
    expect(
      extractOpenItems([
        { role: "toolResult", toolName: "Bash", isError: false, content: "ok" },
      ]),
    ).toEqual([]);
  });

  it("matches a result to the nearest preceding call, never to a later one", () => {
    // OpenAI-compatible local servers emit ids like `1`, `2` per response, so a
    // whole range contains repeats. The call a failure belongs to is the one
    // that precedes it; a later call reusing the id says nothing about it.
    expect(
      extractOpenItems([
        assistant("", [{ id: "1", name: "Read", arguments: { file_path: "a.ts" } }]),
        failure("Read", "file not found", "1"),
        assistant("", [{ id: "1", name: "Write", arguments: { file_path: "a.ts" } }]),
        {
          role: "toolResult",
          toolName: "Write",
          isError: false,
          toolCallId: "1",
          content: [{ type: "text", text: "written" }],
        },
      ]),
    ).toEqual(["Read: file not found"]);
  });

  it("does not treat a failed edit as a repair", () => {
    expect(
      extractOpenItems([
        assistant("", [{ id: "r1", name: "Read", arguments: { file_path: "a.ts" } }]),
        failure("Read", "file not found", "r1"),
        assistant("", [{ id: "w1", name: "Write", arguments: { file_path: "a.ts" } }]),
        failure("Write", "the write itself failed", "w1"),
      ]),
    ).toEqual(["Read: file not found", "Write: the write itself failed"]);
  });

  it("does not let a call that never returned hide a failure", () => {
    expect(
      extractOpenItems([
        assistant("", [{ id: "r1", name: "Read", arguments: { file_path: "a.ts" } }]),
        failure("Read", "file not found", "r1"),
        // Unverifiable, so it cannot count as the repair that resolved the
        // failure above: an unresolved call is not evidence of anything.
        assistant("", [{ id: "w1", name: "Write", arguments: { file_path: "a.ts" } }]),
      ]),
    ).toEqual(["Read: file not found"]);
  });
});

describe("extractNextSteps", () => {
  it("reads unchecked checkboxes and literal TODOs", () => {
    expect(
      extractNextSteps([
        assistant("- [ ] wire the new layer\n- [x] done\nTODO: run the suite"),
      ]),
    ).toEqual(["wire the new layer", "run the suite"]);
  });

  it("does not turn prose into a task list", () => {
    expect(
      extractNextSteps([
        assistant("## Next Steps\n\nEverything below was finished already."),
      ]),
    ).toEqual([]);
  });

  it("reads the last assistant message that has text", () => {
    expect(
      extractNextSteps([assistant("TODO: old"), assistant(""), assistant("TODO: new")]),
    ).toEqual(["new"]);
  });

  it("bounds the list", () => {
    const steps = extractNextSteps([
      assistant(
        Array.from({ length: TRAJECTORY_MAX_NEXT_STEPS + 4 }, (_, i) => `- [ ] step ${i}`).join("\n"),
      ),
    ]);
    expect(steps).toHaveLength(TRAJECTORY_MAX_NEXT_STEPS);
  });
});

describe("buildTrajectorySummary", () => {
  const range: TrajectoryMessage[] = [
    user("older ask"),
    assistant("", [{ id: "call-1", name: "Bash", arguments: { command: "ls" } }]),
    failure("Bash", "cannot ls here", "call-1"),
    user("the ask that matters"),
    assistant("TODO: finish the record"),
  ];

  it("carries the goal, the unresolved failures and the next step", () => {
    const summary = buildTrajectorySummary({ messages: range });
    expect(summary.sections).toContain("## Goal");
    expect(summary.sections).toContain("the ask that matters");
    expect(summary.sections).toContain("## Blocked");
    expect(summary.sections).toContain("- Bash: cannot ls here");
    expect(summary.sections).toContain("## Next Steps");
    expect(summary.sections).toContain("- finish the record");
    expect(summary.stats).toEqual({
      messages: 5,
      toolCalls: 1,
      failedToolCalls: 1,
    });
    expect(summary.goal).toBe("the ask that matters");
  });

  it("carries as a real summary, not a note", () => {
    // The headings and the minimum length are the ones the runtime's summary
    // check enforces, so a trajectory checkpoint can be carried into the next
    // summarization request like any other summary instead of being a special
    // case.
    const summary = buildTrajectorySummary({ messages: range });
    expect(carryableAsSummary(summary.sections)).toBe(true);
  });

  it("says so when a section has nothing to carry", () => {
    const summary = buildTrajectorySummary({ messages: [assistant("done")] });
    expect(summary.sections).toContain("(no user request was recorded in this range)");
    expect(summary.sections).toContain("## Blocked\n(none recorded)");
    expect(summary.sections).toContain("## Next Steps\n(no open next step was recorded)");
    expect(summary.goal).toBeUndefined();
  });

  it("keeps the carried summary ahead of the sections, bounded", () => {
    const summary = buildTrajectorySummary({
      messages: range,
      previousSummary: "  The earlier task summary.  ",
    });
    expect(summary.carried).toBe("The earlier task summary.");
    expect(summary.summary.startsWith("The earlier task summary.")).toBe(true);
    expect(summary.sections).not.toContain("The earlier task summary.");
  });

  it("bounds a carried summary that has grown past its budget", () => {
    const summary = buildTrajectorySummary({
      messages: range,
      previousSummary: "x".repeat(10_000),
      maxPreviousChars: 64,
    });
    expect(summary.carried?.length).toBe(65);
  });

  it("treats a blank carried summary as none", () => {
    expect(buildTrajectorySummary({ messages: range, previousSummary: "  " }).carried)
      .toBeUndefined();
  });

  it("never throws on messages it does not understand", () => {
    const summary = buildTrajectorySummary({
      messages: [
        { role: "custom" },
        { role: "assistant", content: "not a block list" },
        { role: "toolResult", isError: true },
      ],
    });
    expect(summary.sections).toContain("## Goal");
    expect(summary.openItems).toEqual(["tool"]);
  });
});
