import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  assistantTurnContent,
  assistantTurnResponseOutputTokens,
  assistantTurnResponseOutputIsEstimated,
  assistantTurnUsage,
  buildTranscriptEntries,
  subagentRunsEqual,
} = await import("../src/lib/assistant-turns.ts");

function message(id, role, content, extra = {}) {
  return {
    id,
    role,
    content,
    createdAt: `2026-07-28T00:00:0${id.length}.000Z`,
    ...extra,
  };
}

test("groups assistant fragments and tools into one conversational turn", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Fix the issue"),
    message("intro", "assistant", "I will inspect the code."),
    message("read", "tool", "result", {
      toolName: "Read",
      toolCallId: "read",
    }),
    message("followup", "assistant", "The problem is in the renderer."),
    message("edit", "tool", "done", {
      toolName: "Edit",
      toolCallId: "edit",
    }),
    message("final", "assistant", "Fixed and verified."),
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "message");
  assert.equal(entries[1].kind, "assistant-turn");
  assert.deepEqual(
    entries[1].parts.map((part) => part.kind),
    ["message", "activity", "message", "activity", "message"],
  );
  assert.equal(entries[1].anchorId, "intro");
  assert.equal(
    assistantTurnContent(entries[1]),
    "I will inspect the code.\n\nThe problem is in the renderer.\n\nFixed and verified.",
  );
});

test("assistant turn output prefers exact usage and falls back to stopped estimates", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Stop"),
    message("first", "assistant", "Partial", { responseOutputTokens: 7 }),
    message("second", "assistant", "Done", {
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      responseOutputTokens: 99,
    }),
  ]);
  const turn = entries[1];
  assert.equal(turn.kind, "assistant-turn");
  assert.equal(assistantTurnResponseOutputTokens(turn), 10);
  assert.equal(assistantTurnResponseOutputIsEstimated(turn), true);
});

test("keeps a recovered tool error inside one successful assistant turn", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Inspect the handlers"),
    message("read", "tool", "directory", {
      toolName: "Read",
      toolCallId: "read",
      toolStatus: "error",
      isError: true,
    }),
    message("recovery", "assistant", "I will list the directory instead."),
    message("glob", "tool", "router.go", {
      toolName: "Glob",
      toolCallId: "glob",
      toolStatus: "success",
    }),
    message("final", "assistant", "The handler is registered in router.go."),
  ]);

  assert.equal(entries.length, 2);
  const turn = entries[1];
  assert.equal(turn.kind, "assistant-turn");
  assert.deepEqual(
    turn.parts.map((part) => part.kind),
    ["activity", "message", "activity", "message"],
  );
  assert.equal(turn.parts[0].items[0].message.toolStatus, "error");
  assert.equal(turn.parts[0].items[0].message.isError, true);
  assert.equal(turn.parts[2].items[0].message.toolStatus, "success");
  assert.match(assistantTurnContent(turn), /registered in router\.go/);
});

test("starts a new assistant turn only after the next user message", () => {
  const { entries } = buildTranscriptEntries([
    message("user-1", "user", "First"),
    message("assistant-1", "assistant", "First response"),
    message("user-2", "user", "Second"),
    message("assistant-2", "assistant", "Second response"),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "assistant-turn", "message", "assistant-turn"],
  );
});

test("keeps thinking and tool-only activity in the assistant turn", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Inspect"),
    message("thinking", "assistant", "", { thinking: "Planning" }),
    message("tool", "tool", "result", {
      toolName: "Read",
      toolCallId: "tool",
    }),
    message("answer", "assistant", "Done"),
  ]);

  const turn = entries[1];
  assert.equal(turn.kind, "assistant-turn");
  assert.equal(turn.parts[0].kind, "activity");
  assert.deepEqual(
    turn.parts[0].items.map((item) => item.kind),
    ["thinking", "tool"],
  );
  assert.equal(turn.parts[0].endedAt, "2026-07-28T00:00:06.000Z");
});

test("aggregates provider usage across response fragments", () => {
  const usage = {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    totalTokens: 14,
  };
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Count"),
    message("first", "assistant", "One", { usage }),
    message("tool", "tool", "result", { toolCallId: "tool" }),
    message("second", "assistant", "Two", { usage }),
  ]);
  const turn = entries[1];

  assert.equal(turn.kind, "assistant-turn");
  assert.deepEqual(assistantTurnUsage(turn), {
    inputTokens: 20,
    outputTokens: 8,
    cacheReadTokens: 4,
    totalTokens: 28,
  });
});

test("nests delegate rows under the Task call that spawned them", () => {
  const { entries, visible } = buildTranscriptEntries([
    message("user", "user", "Audit the store"),
    message("task", "tool", "report", {
      toolName: "Task",
      toolCallId: "task-1",
    }),
    message("delegate-think", "assistant", "", {
      thinking: "Looking for the reducer",
      parentToolCallId: "task-1",
      agentName: "code-reviewer",
    }),
    message("delegate-read", "tool", "file", {
      toolName: "Read",
      toolCallId: "read-1",
      parentToolCallId: "task-1",
      agentName: "code-reviewer",
    }),
    message("delegate-report", "assistant", "Two dead branches.", {
      parentToolCallId: "task-1",
      agentName: "code-reviewer",
    }),
    message("final", "assistant", "Removed both."),
  ]);

  // The delegate's rows are not transcript rows: the minimap and the turn
  // stream only ever see the parent's `Task` call.
  assert.deepEqual(
    visible.map((entry) => entry.id),
    ["user", "task", "final"],
  );
  const turn = entries[1];
  assert.equal(turn.kind, "assistant-turn");
  const activity = turn.parts[0];
  assert.equal(activity.kind, "activity");
  assert.equal(activity.items.length, 1);
  assert.equal(activity.items[0].message.id, "task");
  assert.equal(activity.items[0].delegate.agentName, "code-reviewer");
  assert.deepEqual(
    activity.items[0].delegate.items.map((item) => item.kind),
    ["thinking", "tool", "answer"],
  );
});

test("parallel delegate nodes keep parent Task order when child rows interleave", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Fan out"),
    message("task-a", "tool", "first report", {
      toolName: "Task",
      toolCallId: "task-a",
    }),
    message("task-b", "tool", "second report", {
      toolName: "Task",
      toolCallId: "task-b",
    }),
    message("b-read", "tool", "b", {
      toolName: "Read",
      parentToolCallId: "task-b",
      agentName: "scout-b",
    }),
    message("a-read", "tool", "a", {
      toolName: "Read",
      parentToolCallId: "task-a",
      agentName: "scout-a",
    }),
    message("final", "assistant", "Both finished."),
  ]);

  const activity = entries[1].parts[0];
  assert.equal(activity.kind, "activity");
  assert.deepEqual(
    activity.items.map((item) => item.message.id),
    ["task-a", "task-b"],
  );
  assert.deepEqual(
    activity.items.map((item) => item.delegate.agentName),
    ["scout-a", "scout-b"],
  );
});

test("a delegate turn with both reasoning and text keeps both rows", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Delegate"),
    message("task", "tool", "report", { toolName: "Task", toolCallId: "t" }),
    message("both", "assistant", "Here is the report.", {
      thinking: "Summarizing",
      parentToolCallId: "t",
    }),
  ]);

  const delegate = entries[1].parts[0].items[0].delegate;
  assert.equal(delegate.agentName, undefined);
  assert.deepEqual(
    delegate.items.map((item) => item.kind),
    ["thinking", "answer"],
  );
});

function mark(id, throughMessageId, overrides = {}) {
  return {
    id,
    throughMessageId,
    generation: 1,
    summaryTokens: 900,
    summarized: true,
    ...overrides,
  };
}

test("a compaction row divides the transcript right after the message it covers", () => {
  const { entries } = buildTranscriptEntries(
    [
      message("user-1", "user", "First"),
      message("assistant-1", "assistant", "First response"),
      message("user-2", "user", "Second"),
      message("assistant-2", "assistant", "Second response"),
    ],
    [mark("cp-1", "assistant-1")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "assistant-turn", "compaction", "message", "assistant-turn"],
  );
  assert.equal(entries[2].mark.id, "cp-1");
});

test("a compaction row ends the assistant turn it lands inside", () => {
  // The runtime splices its checkpoint after the anchor entry, so a later
  // fragment of the same provider turn belongs to a new visual turn here too.
  const { entries } = buildTranscriptEntries(
    [
      message("user", "user", "Work"),
      message("before", "assistant", "Reading"),
      message("tool", "tool", "result", { toolName: "Read", toolCallId: "t" }),
      message("after", "assistant", "Done"),
    ],
    [mark("cp-1", "tool")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "assistant-turn", "compaction", "assistant-turn"],
  );
  assert.equal(entries[3].id, "after");
});

test("every checkpoint gets its own row, and an orphaned one gets none", () => {
  const { entries } = buildTranscriptEntries(
    [
      message("user-1", "user", "First"),
      message("user-2", "user", "Second"),
    ],
    [
      mark("cp-1", "user-1"),
      mark("cp-2", "user-2", { generation: 2, summarized: false }),
      // Its anchor was rewritten away, so this checkpoint has nowhere to sit.
      mark("cp-3", "gone"),
    ],
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "compaction", "message", "compaction"],
  );
  assert.deepEqual(
    entries
      .filter((entry) => entry.kind === "compaction")
      .map((entry) => entry.mark.id),
    ["cp-1", "cp-2"],
  );
});

test("delegate runs compare by rows so memoized groups still update", () => {
  const rowA = message("a", "tool", "one", { toolCallId: "a" });
  const rowB = message("b", "tool", "two", { toolCallId: "b" });
  const run = (items, agentName) => ({
    ...(agentName ? { agentName } : {}),
    items,
  });

  assert.equal(subagentRunsEqual(undefined, undefined), true);
  assert.equal(subagentRunsEqual(run([]), undefined), false);
  // Rebuilt on every render, so identity never matches: the rows must.
  assert.equal(
    subagentRunsEqual(
      run([{ kind: "tool", message: rowA }], "reviewer"),
      run([{ kind: "tool", message: rowA }], "reviewer"),
    ),
    true,
  );
  assert.equal(
    subagentRunsEqual(
      run([{ kind: "tool", message: rowA }]),
      run([{ kind: "tool", message: rowB }]),
    ),
    false,
  );
  // A streamed row grew: same length, same message, different kind.
  assert.equal(
    subagentRunsEqual(
      run([{ kind: "thinking", message: rowA }]),
      run([{ kind: "answer", message: rowA }]),
    ),
    false,
  );
  assert.equal(
    subagentRunsEqual(
      run([{ kind: "tool", message: rowA }], "reviewer"),
      run([{ kind: "tool", message: rowA }], "planner"),
    ),
    false,
  );
});

test("parent tools after a Task fan-out stay out of the delegation card (D319)", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Investigate"),
    message("think-before", "assistant", "", { thinking: "I will delegate." }),
    message("task-a", "tool", "running", {
      toolName: "Task",
      toolCallId: "task-a",
    }),
    message("task-b", "tool", "running", {
      toolName: "Task",
      toolCallId: "task-b",
    }),
    message("think-after", "assistant", "", {
      thinking: "I will keep working in parallel.",
    }),
    message("read", "tool", "file", {
      toolName: "Read",
      toolCallId: "read",
    }),
    message("wait", "tool", "done", {
      toolName: "TaskWait",
      toolCallId: "wait",
    }),
  ]);

  const turn = entries[1];
  assert.equal(turn.kind, "assistant-turn");
  assert.deepEqual(
    turn.parts.map((part) => [
      part.kind,
      part.items.map((item) => item.message.id),
    ]),
    [
      ["activity", ["think-before"]],
      ["activity", ["task-a", "task-b"]],
      ["activity", ["think-after", "read", "wait"]],
    ],
  );
});
