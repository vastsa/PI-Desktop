import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  assistantTurnContent,
  assistantTurnMessages,
  assistantTurnTools,
  assistantTurnResponseOutputTokens,
  assistantTurnResponseOutputIsEstimated,
  assistantTurnUsage,
  buildTranscriptEntries,
  reuseTranscriptEntries,
  subagentRunsEqual,
  transcriptEntryMessages,
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
  assert.equal(entries[1].startedAt, entries[0].message.createdAt);
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

test("marked steering stays ordered inside one assistant turn", () => {
  const attachment = { kind: "file", name: "notes.txt", ref: "notes.txt" };
  const root = message("root", "user", "Fix it", {
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  const steering = message("steer", "user", "Also cover attachments", {
    steering: true,
    attachments: [attachment],
    createdAt: "2026-07-28T00:00:03.000Z",
    usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 },
  });
  const { entries } = buildTranscriptEntries([
    root,
    message("intro", "assistant", "Inspecting", {
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    }),
    message("read", "tool", "result", { toolName: "Read" }),
    steering,
    message("continue", "assistant", "Continuing with the new constraint"),
    message("edit", "tool", "done", { toolName: "Edit" }),
    message("final", "assistant", "Fixed", {
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    }),
  ]);

  assert.equal(entries.length, 2);
  const turn = entries[1];
  assert.equal(turn.kind, "assistant-turn");
  assert.equal(turn.id, "intro");
  assert.equal(turn.startedAt, root.createdAt);
  assert.deepEqual(
    turn.parts.map((part) => part.kind),
    ["message", "activity", "steering", "message", "activity", "message"],
  );
  assert.equal(turn.parts[2].message, steering);
  assert.equal(turn.parts[2].message.attachments[0], attachment);
  assert.deepEqual(
    assistantTurnMessages(turn).map((item) => item.id),
    ["intro", "continue", "final"],
  );
  assert.equal(
    assistantTurnContent(turn),
    "Inspecting\n\nContinuing with the new constraint\n\nFixed",
  );
  assert.deepEqual(assistantTurnUsage(turn), {
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
  });
  assert.deepEqual(
    transcriptEntryMessages(entries).map((item) => item.id),
    ["root", "intro", "continue", "final"],
  );
  assert.deepEqual(
    assistantTurnTools(turn).map((item) => item.id),
    ["read", "edit"],
  );
});

test("steering before first assistant output starts the same stable turn", () => {
  const root = message("root", "user", "Start", {
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  const steering = message("steer", "user", "Use the narrow path", {
    steering: true,
    createdAt: "2026-07-28T00:00:01.000Z",
  });
  const records = [
    root,
    steering,
    message("read", "tool", "result", { toolName: "Read" }),
    message("final", "assistant", "Done"),
  ];
  const first = buildTranscriptEntries(records).entries;
  const reloaded = buildTranscriptEntries(
    records.map((record) => ({
      ...record,
      ...(record.attachments
        ? { attachments: record.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    })),
  ).entries;

  assert.deepEqual(first, reloaded);
  assert.equal(first.length, 2);
  assert.equal(first[1].kind, "assistant-turn");
  assert.equal(first[1].id, "steer");
  assert.equal(first[1].startedAt, root.createdAt);
  assert.deepEqual(
    first[1].parts.map((part) => part.kind),
    ["steering", "activity", "message"],
  );
});

test("orphaned steering stays visible and ordinary users keep hard boundaries", () => {
  const leading = message("leading", "user", "Supplement from unloaded history", {
    steering: true,
  });
  const { entries } = buildTranscriptEntries([
    leading,
    message("partial", "assistant", "Stopped", { status: "aborted" }),
    message("queued", "user", "A new task"),
    message("next", "assistant", "New answer"),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "assistant-turn", "message", "assistant-turn"],
  );
  assert.equal(entries[0].message, leading);
  assert.equal(entries[1].id, "partial");
  assert.equal(entries[3].id, "next");
  assert.deepEqual(
    transcriptEntryMessages(entries).map((message) => message.id),
    ["leading", "partial", "queued", "next"],
  );
});

test("steering-only start can abort before a later ordinary task", () => {
  const { entries } = buildTranscriptEntries([
    message("root", "user", "Start"),
    message("steer", "user", "Use the fallback", { steering: true }),
    message("aborted", "assistant", "Stopped", { status: "aborted" }),
    message("queued", "user", "New task"),
    message("next", "assistant", "New answer"),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "assistant-turn", "message", "assistant-turn"],
  );
  assert.equal(entries[1].id, "steer");
  assert.deepEqual(
    entries[1].parts.map((part) => part.kind),
    ["steering", "message"],
  );
  assert.equal(entries[3].id, "next");
});

test("compaction prevents marked steering from merging backward", () => {
  const { entries } = buildTranscriptEntries(
    [
      message("before", "assistant", "Before"),
      message("steer", "user", "After compact", { steering: true }),
      message("after", "assistant", "After"),
    ],
    [mark("cp", "before")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["assistant-turn", "compaction", "message", "assistant-turn"],
  );
  assert.equal(entries[2].message.id, "steer");
});

test("assistant turns retain the initiating user timestamp when it is loaded", () => {
  const user = message("user", "user", "Start");
  const first = buildTranscriptEntries([
    user,
    message("assistant", "assistant", "Working"),
  ]).entries[1];
  const paged = buildTranscriptEntries([
    message("assistant", "assistant", "Working"),
  ]).entries[0];

  assert.equal(first.kind, "assistant-turn");
  assert.equal(first.startedAt, user.createdAt);
  assert.equal(paged.kind, "assistant-turn");
  assert.equal(paged.startedAt, undefined);
});

test("started-at metadata participates in transcript entry reuse", () => {
  const original = buildTranscriptEntries([
    message("user", "user", "Start"),
    message("assistant", "assistant", "Done"),
  ]).entries;
  const changed = original.map((entry) =>
    entry.kind === "assistant-turn"
      ? { ...entry, startedAt: "2026-07-28T00:00:00.000Z" }
      : entry,
  );
  const reused = reuseTranscriptEntries(original, changed);

  assert.notEqual(reused[1], original[1]);
  assert.equal(reused[1].startedAt, "2026-07-28T00:00:00.000Z");
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

test("a resumed delegation continues in the latest Task card (ADR 0279)", () => {
  const { entries, visible } = buildTranscriptEntries([
    message("user", "user", "Audit the store"),
    message("task-1", "tool", "report", {
      toolName: "Task",
      toolCallId: "task-1",
      toolArgs: { agent: "explorer", task: "Explore the parser." },
      toolResult: { details: { delegationId: "del-1" } },
    }),
    message("delegate-1", "assistant", "Found the parser.", {
      parentToolCallId: "task-1",
      agentName: "explorer",
    }),
    message("task-2", "tool", "report", {
      toolName: "Task",
      toolCallId: "task-2",
      toolArgs: { agent: "explorer", task: "Now cover the lexer.", resume: "del-1" },
      toolResult: { details: { delegationId: "del-2" } },
    }),
    message("delegate-2", "assistant", "Covered the lexer.", {
      parentToolCallId: "task-2",
      agentName: "explorer",
    }),
    message("final", "assistant", "Both halves are covered."),
  ]);

  // Each `Task` call still owns its own row in the parent's turn stream…
  assert.deepEqual(
    visible.map((entry) => entry.id),
    ["user", "task-1", "task-2", "final"],
  );
  const turn = entries[1];
  const activity = turn.parts[0];
  assert.equal(activity.kind, "activity");
  assert.equal(activity.items.length, 2);
  // …but the chain's rows all live on the latest card, in production order, so
  // a resumed run reads as one continuing conversation instead of a card that
  // starts from nothing.
  assert.equal(activity.items[0].delegate, undefined);
  assert.equal(activity.items[1].delegate.agentName, "explorer");
  assert.deepEqual(
    activity.items[1].delegate.items.map((item) => item.message.id),
    ["delegate-1", "delegate-2"],
  );
  assert.deepEqual(
    turn.ownedToolMessages.map((item) => item.id),
    ["task-1", "task-2"],
  );
});

test("resumed delegates keep raw tool ownership on each original Task turn", () => {
  const task1 = message("task-1", "tool", "report", {
    toolName: "Task",
    toolCallId: "task-1",
    toolResult: { details: { delegationId: "del-1" } },
  });
  const edit1 = message("edit-1", "tool", "done", {
    toolName: "Edit",
    parentToolCallId: "task-1",
  });
  const task2 = message("task-2", "tool", "report", {
    toolName: "Task",
    toolCallId: "task-2",
    toolArgs: { resume: "del-1" },
    toolResult: { details: { delegationId: "del-2" } },
  });
  const edit2 = message("edit-2", "tool", "done", {
    toolName: "Edit",
    parentToolCallId: "task-2",
  });
  const { entries } = buildTranscriptEntries([
    message("user-1", "user", "First"),
    task1,
    edit1,
    message("answer-1", "assistant", "First done"),
    message("user-2", "user", "Second"),
    task2,
    edit2,
    message("answer-2", "assistant", "Second done"),
  ]);
  const first = entries[1];
  const second = entries[3];

  assert.equal(first.kind, "assistant-turn");
  assert.equal(second.kind, "assistant-turn");
  assert.deepEqual(
    first.ownedToolMessages.map((item) => item.id),
    ["task-1", "edit-1"],
  );
  assert.deepEqual(
    second.ownedToolMessages.map((item) => item.id),
    ["task-2", "edit-2"],
  );
  assert.equal(first.parts[0].items[0].delegate, undefined);
  assert.deepEqual(
    second.parts[0].items[0].delegate.items.map((item) => item.message.id),
    ["edit-1", "edit-2"],
  );
});

test("delayed delegate and rollback updates invalidate only the owning turn", () => {
  const task = message("task", "tool", "report", {
    toolName: "Task",
    toolCallId: "task-call",
  });
  const base = [
    message("user-1", "user", "First"),
    task,
    message("answer-1", "assistant", "First done"),
    message("user-2", "user", "Second"),
    message("answer-2", "assistant", "Second done"),
  ];
  const initial = buildTranscriptEntries(base).entries;
  const delayedEdit = message("delayed-edit", "tool", "done", {
    toolName: "Edit",
    parentToolCallId: "task-call",
    toolResult: { details: { review: { state: "active" } } },
  });
  const delayed = buildTranscriptEntries([...base, delayedEdit]).entries;
  const reusedDelayed = reuseTranscriptEntries(initial, delayed);

  assert.notEqual(reusedDelayed[1], initial[1]);
  assert.equal(reusedDelayed[3], initial[3]);
  assert.deepEqual(
    reusedDelayed[1].ownedToolMessages.map((item) => item.id),
    ["task", "delayed-edit"],
  );

  const rolledBackEdit = {
    ...delayedEdit,
    toolResult: { details: { review: { state: "rolledBack" } } },
  };
  const rolledBack = buildTranscriptEntries([...base, rolledBackEdit]).entries;
  const reusedRollback = reuseTranscriptEntries(delayed, rolledBack);

  assert.notEqual(reusedRollback[1], delayed[1]);
  assert.equal(reusedRollback[3], delayed[3]);
  assert.equal(
    reusedRollback[1].ownedToolMessages.at(-1),
    rolledBackEdit,
  );

  const stable = reuseTranscriptEntries(
    rolledBack,
    buildTranscriptEntries([...base, rolledBackEdit]).entries,
  );
  assert.equal(stable[1], rolledBack[1]);
  assert.equal(
    stable[1].ownedToolMessages,
    rolledBack[1].ownedToolMessages,
  );
});

test("a resume link whose parent Task row is gone leaves the card intact", () => {
  const { entries } = buildTranscriptEntries([
    message("user", "user", "Audit the store"),
    message("task-2", "tool", "report", {
      toolName: "Task",
      toolCallId: "task-2",
      toolArgs: { agent: "explorer", task: "More.", resume: "del-1" },
      toolResult: { details: { delegationId: "del-2" } },
    }),
    message("delegate-2", "assistant", "More.", {
      parentToolCallId: "task-2",
      agentName: "explorer",
    }),
  ]);

  const delegate = entries[1].parts[0].items[0].delegate;
  assert.deepEqual(
    delegate.items.map((item) => item.message.id),
    ["delegate-2"],
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

test("reuses unchanged activity parts when only the tail thinking token changes", () => {
  const history = [
    message("user", "user", "Work through the files"),
  ];
  for (let index = 0; index < 40; index += 1) {
    history.push(
      message(`read-${index}`, "tool", "ok", {
        toolName: "Read",
        toolCallId: `read-${index}`,
      }),
    );
  }
  history.push(message("mid", "assistant", "Continuing."));
  const thinking = message("think-live", "assistant", "", {
    thinking: "Looking at step 1",
    status: "streaming",
  });
  const first = buildTranscriptEntries([...history, thinking]);
  const nextThinking = {
    ...thinking,
    thinking: "Looking at step 1 and 2",
  };
  const rebuilt = buildTranscriptEntries([...history, nextThinking]);
  const shared = reuseTranscriptEntries(first.entries, rebuilt.entries);
  const firstTurn = first.entries[1];
  const sharedTurn = shared[1];
  assert.equal(firstTurn.kind, "assistant-turn");
  assert.equal(sharedTurn.kind, "assistant-turn");
  const firstTools = firstTurn.parts[0];
  const sharedTools = sharedTurn.parts[0];
  assert.equal(firstTools.kind, "activity");
  assert.equal(sharedTools.kind, "activity");
  assert.equal(sharedTools, firstTools);
  assert.equal(sharedTools.items[0], firstTools.items[0]);
  assert.equal(sharedTools.items[39], firstTools.items[39]);
  const firstMid = firstTurn.parts[1];
  const sharedMid = sharedTurn.parts[1];
  assert.equal(firstMid.kind, "message");
  assert.equal(sharedMid, firstMid);
  const firstThink = firstTurn.parts[2];
  const sharedThink = sharedTurn.parts[2];
  assert.equal(firstThink.kind, "activity");
  assert.equal(sharedThink.kind, "activity");
  assert.notEqual(sharedThink, firstThink);
  assert.equal(sharedThink.items[0].message, nextThinking);
});
