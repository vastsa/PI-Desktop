import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries, isStandaloneRunActivity } = await import(
  "../src/lib/assistant-turns.ts"
);
const {
  projectTurnProcess,
  segmentTurnProcess,
  turnProcessTiming,
  turnProcessPhase,
} = await import("../src/lib/turn-process.ts");
const { cachedActivitySummary, cachedVisibleProcessSteps } = await import(
  "../src/lib/transcript-activity-summary.ts"
);

const message = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  createdAt: "2026-09-17T00:00:00.000Z",
  ...extra,
});
const turn = (messages) =>
  buildTranscriptEntries(messages).entries.find(
    (entry) => entry.kind === "assistant-turn",
  );
const tool = (id, toolName, extra = {}) =>
  message(id, "tool", "", { toolName, ...extra });

test("one turn groups thinking, tools and progress while retaining only the trailing answer", () => {
  const entry = turn([
    message("user", "user", "Inspect"),
    message("intro", "assistant", "I will inspect", { thinking: "Plan" }),
    tool("read", "Read", { toolResult: "result" }),
    message("progress", "assistant", "I found the cause"),
    tool("edit", "Edit", { toolResult: "updated" }),
    message("final", "assistant", "Fixed"),
  ]);
  const projected = projectTurnProcess(entry);
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["final"],
  );
  assert.equal(cachedVisibleProcessSteps(projected.process, false, false), 5);
  assert.equal(cachedVisibleProcessSteps(projected.process, true, false), 4);
});

test("streamed text stays readable until later work establishes it as progress", () => {
  const text = message("text", "assistant", "Inspecting", { status: "streaming" });
  assert.equal(projectTurnProcess(turn([text])).responses[0].message, text);
  const projected = projectTurnProcess(
    turn([text, tool("read", "Read")]),
  );
  assert.equal(projected.responses.length, 0);
  assert.equal(projected.process[0].message, text);
});

test("plain answers need no empty process disclosure", () => {
  const projected = projectTurnProcess(turn([message("final", "assistant", "Answer")]));
  assert.equal(projected.process.length, 0);
  assert.equal(projected.responses.length, 1);
});

test("errors and aborted partial replies remain outside the process", () => {
  const error = message("error", "assistant", "", {
    status: "error",
    error: { code: "INTERNAL", message: "failed" },
  });
  const partial = message("partial", "assistant", "Partial answer", {
    status: "aborted",
  });
  const projected = projectTurnProcess(
    turn([error, tool("read", "Read"), partial]),
  );
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["error", "partial"],
  );
});

test("hidden thinking disappears after reasoning ends without removing stored data", () => {
  const thinking = message("think", "assistant", "", {
    thinking: "Private reasoning",
    status: "streaming",
  });
  const entry = turn([thinking]);
  assert.equal(cachedVisibleProcessSteps(entry.parts, true, true), 1);
  assert.equal(cachedVisibleProcessSteps(entry.parts, true, false), 0);
  const withAnswer = turn([{ ...thinking, content: "Answer" }]);
  assert.equal(
    cachedVisibleProcessSteps(projectTurnProcess(withAnswer).process, true, true),
    0,
  );
  assert.equal(thinking.thinking, "Private reasoning");
});

test("Bash and run aliases render as standalone rows, never inside a group", () => {
  const entry = turn([
    message("user", "user", "Run it"),
    tool("read", "Read", { toolResult: "a" }),
    tool("bash1", "Bash", { toolArgs: { command: "echo 1" } }),
    tool("bash2", "Bash", { toolArgs: { command: "echo 2" } }),
    tool("grep", "Grep", { toolResult: "b" }),
    tool("shell", "Shell", { toolArgs: { command: "echo 3" } }),
    message("final", "assistant", "Done"),
  ]);
  const activities = entry.parts.filter((part) => part.kind === "activity");
  assert.deepEqual(
    activities.map((part) => part.items.map((item) => item.message.id)),
    [["read"], ["bash1"], ["bash2"], ["grep"], ["shell"]],
  );
  assert.deepEqual(
    activities.map((part) => isStandaloneRunActivity(part.items[0])),
    [false, true, true, false, true],
  );
});

test("adjacent run aliases each keep their own standalone row", () => {
  const entry = turn([
    message("user", "user", "Run"),
    tool("a", "Bash", { toolArgs: { command: "a" } }),
    tool("b", "exec", { toolArgs: { command: "b" } }),
    tool("c", "shell", { toolArgs: { command: "c" } }),
  ]);
  const activities = entry.parts.filter((part) => part.kind === "activity");
  assert.equal(activities.length, 3);
  assert.ok(activities.every((part) => part.items.length === 1));
  assert.ok(activities.every((part) => isStandaloneRunActivity(part.items[0])));
});

test("a run row splits the surrounding ordinary activity into its own groups", () => {
  const entry = turn([
    message("user", "user", "Run"),
    tool("read1", "Read", { toolResult: "a" }),
    tool("grep1", "Grep", { toolResult: "b" }),
    tool("bash", "Bash", { toolArgs: { command: "pnpm test" } }),
    tool("read2", "Read", { toolResult: "c" }),
    tool("edit2", "Edit", { toolResult: "d" }),
  ]);
  const activities = entry.parts.filter((part) => part.kind === "activity");
  assert.deepEqual(
    activities.map((part) => part.items.map((item) => item.message.id)),
    [["read1", "grep1"], ["bash"], ["read2", "edit2"]],
  );
});

test("process segments pull every Bash row out and keep chronological chunks", () => {
  const entry = turn([
    message("user", "user", "run"),
    tool("read", "Read", { toolResult: "a" }),
    tool("grep", "Grep", { toolResult: "b" }),
    tool("bash", "Bash", { toolArgs: { command: "ls" } }),
    tool("edit", "Edit", { toolResult: "c" }),
  ]);
  const segments = segmentTurnProcess(projectTurnProcess(entry).process, "command-first");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["process", "run", "process"],
  );
  assert.deepEqual(
    segments.map((segment) => segment.key),
    ["read", "bash", "edit"],
  );
  assert.deepEqual(
    segments[0].parts.flatMap((part) =>
      part.kind === "activity" ? part.items.map((item) => item.message.id) : [],
    ),
    ["read", "grep"],
  );
});

test("a Bash-only turn has no process segment at all", () => {
  const entry = turn([
    message("user", "user", "run"),
    tool("bash1", "Bash", { toolArgs: { command: "a" } }),
    tool("bash2", "Bash", { toolArgs: { command: "b" } }),
  ]);
  const segments = segmentTurnProcess(projectTurnProcess(entry).process, "command-first");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["run", "run"],
  );
});

test("a turn without Bash keeps one process segment", () => {
  const entry = turn([
    message("user", "user", "read"),
    tool("read", "Read", { toolResult: "a" }),
    tool("grep", "Grep", { toolResult: "b" }),
  ]);
  const segments = segmentTurnProcess(projectTurnProcess(entry).process, "command-first");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["process"],
  );
});

test("history timing uses recorded ends and rejects invalid timestamps and durations", () => {
  const entry = turn([
    tool("read", "Read", { toolCompletedAt: "2026-09-17T00:00:02.000Z" }),
    message("answer", "assistant", "Done", {
      createdAt: "2026-09-17T00:00:03.000Z",
      responseDurationMs: 1000,
    }),
  ]);
  const timing = turnProcessTiming(entry.parts);
  assert.equal(timing.endedAt - timing.startedAt, 4000);
  assert.deepEqual(
    turnProcessTiming(
      turn([message("bad", "assistant", "x", { createdAt: "bad" })]).parts,
    ),
    {
      startedAt: undefined,
      endedAt: undefined,
    },
  );
});

test("user boundaries retain independent processes and delegation details stay attached", () => {
  const entries = buildTranscriptEntries([
    message("u1", "user", "one"),
    tool("task", "Task", { toolCallId: "call", toolResult: "started" }),
    message("nested", "assistant", "Delegate answer", { parentToolCallId: "call" }),
    message("a1", "assistant", "one done"),
    message("u2", "user", "two"),
    message("a2", "assistant", "two done"),
  ]).entries.filter((entry) => entry.kind === "assistant-turn");
  assert.equal(entries.length, 2);
  const first = projectTurnProcess(entries[0]);
  assert.equal(first.process[0].items[0].delegate.items[0].message.id, "nested");
  assert.equal(projectTurnProcess(entries[1]).process.length, 0);
});

test("a turn's process is one disclosure that owns every run row", () => {
  // The transcript renders exactly one process disclosure per assistant turn and
  // puts the run rows inside it, so a turn collapses in one gesture instead of
  // leaving a column of sibling disclosures above the answer.
  const entry = turn([
    message("user", "user", "Run"),
    tool("read1", "Read", { toolResult: "a" }),
    tool("bash1", "Bash", { toolArgs: { command: "a" } }),
    tool("grep1", "Grep", { toolResult: "b" }),
    tool("bash2", "Bash", { toolArgs: { command: "b" } }),
    message("final", "assistant", "Done"),
  ]);
  const process = projectTurnProcess(entry).process;
  // Every part of the process belongs to that one disclosure, and the answer
  // stays outside it.
  assert.ok(process.every((part) => entry.parts.includes(part)));
  assert.equal(projectTurnProcess(entry).responses.length, 1);
});

test("folding commands coalesces mixed work across run rows without mutating entry parts", () => {
  // The preference only decides where run rows sit. Both values keep exactly one
  // segment, so the turn still renders one disclosure; off joins the ordinary
  // activity chunks around a run row into one rendered group.
  const entry = turn([
    message("user", "user", "Run"),
    message("intro", "assistant", "Inspecting"),
    tool("read", "Read", { toolResult: "a" }),
    tool("grep", "Grep", { toolResult: "b" }),
    tool("bash", "Bash", { toolArgs: { command: "pnpm test" } }),
    tool("edit", "Edit", { toolResult: "c" }),
    tool("write", "Write", { toolResult: "d" }),
    message("progress", "assistant", "Still working", {
      createdAt: "2026-09-17T00:00:05.000Z",
    }),
    tool("read2", "Read", { toolResult: "e" }),
    message("final", "assistant", "Done", {
      createdAt: "2026-09-17T00:00:06.000Z",
    }),
  ]);
  const process = projectTurnProcess(entry).process;
  const sourceActivities = process.filter((part) => part.kind === "activity");
  const sourceItems = sourceActivities.flatMap((part) => part.items);
  const sourceEnds = sourceActivities.map((part) => part.endedAt);
  // Freeze the cached projection so an in-place merge throws instead of quietly
  // rewriting the entry.
  for (const part of process) {
    if (part.kind !== "activity") continue;
    Object.freeze(part.items);
    Object.freeze(part);
  }
  Object.freeze(process);
  const [segment] = segmentTurnProcess(process, "fully-folded");
  assert.equal(segment.kind, "process");
  // Progress text stays a paragraph boundary, so the run joins the group before
  // it rather than the one after it.
  assert.deepEqual(
    segment.parts.map((part) => part.kind),
    ["message", "activity", "message", "activity"],
  );
  const merged = segment.parts[1];
  assert.notEqual(merged, process[1]);
  assert.deepEqual(
    merged.items.map((item) => item.message.id),
    ["read", "grep", "bash", "edit", "write"],
  );
  // The coalesced group keeps every source item identity.
  assert.ok(merged.items.every((item, index) => item === sourceItems[index]));
  // Its end is the last source group's end, not the first one's, and the source
  // parts keep the ends the entry builder gave them.
  assert.equal(merged.endedAt, "2026-09-17T00:00:05.000Z");
  assert.deepEqual(sourceActivities.map((part) => part.endedAt), sourceEnds);
  // A group with nothing to join keeps its cached source part identity.
  assert.equal(segment.parts[0], process[0]);
  assert.equal(segment.parts[3], process[5]);
  assert.deepEqual(
    segment.parts[3].items.map((item) => item.message.id),
    ["read2"],
  );
  // ON is unchanged: the original chunks are still separate and the run row is
  // still a standalone segment with its original item identity.
  const on = segmentTurnProcess(process, "command-first");
  assert.deepEqual(on.map((part) => part.kind), ["process", "run", "process"]);
  assert.equal(on[0].parts[0], process[0]);
  assert.equal(on[0].parts[1], process[1]);
  assert.equal(on[1].item, sourceActivities[1].items[0]);
  const again = segmentTurnProcess(process, "command-first");
  assert.deepEqual(again.map((part) => part.kind), on.map((part) => part.kind));
  assert.equal(again[0].parts[0], process[0]);
});

test("folding commands keeps Task topology and progress text as group boundaries", () => {
  const entry = turn([
    message("user", "user", "Run"),
    tool("read", "Read", { toolResult: "a" }),
    tool("bash1", "Bash", { toolArgs: { command: "a" } }),
    tool("task", "Task", { toolCallId: "call", toolResult: "started" }),
    message("nested", "assistant", "Delegate answer", {
      parentToolCallId: "call",
    }),
    tool("bash2", "Bash", { toolArgs: { command: "b" } }),
    tool("edit", "Edit", { toolResult: "c" }),
    message("progress", "assistant", "Progress"),
    tool("write", "Write", { toolResult: "d" }),
  ]);
  const [segment] = segmentTurnProcess(
    projectTurnProcess(entry).process,
    "fully-folded",
  );
  const activityIds = segment.parts.flatMap((part) =>
    part.kind === "activity"
      ? [part.items.map((item) => item.message.id)]
      : [],
  );
  // Ordinary work across the first run coalesces, but no ordinary row joins a
  // Task group on either side. The progress paragraph then starts a new group.
  assert.deepEqual(activityIds, [
    ["read", "bash1"],
    ["task"],
    ["bash2", "edit"],
    ["write"],
  ]);
  const task = segment.parts[1];
  assert.equal(task.kind, "activity");
  assert.equal(task.items[0].delegate.items[0].message.id, "nested");
});

test("flat keeps the original part order and never extracts a run", () => {
  const entry = turn([
    message("user", "user", "Run"),
    tool("read", "Read", { toolResult: "a" }),
    tool("bash", "Bash", { toolArgs: { command: "pnpm test" } }),
    message("progress", "assistant", "Progress"),
    tool("edit", "Edit", { toolResult: "b" }),
  ]);
  const process = projectTurnProcess(entry).process;
  const [segment] = segmentTurnProcess(process, "flat");
  assert.equal(segment.kind, "process");
  assert.equal(segment.parts.length, process.length);
  assert.ok(segment.parts.every((part, index) => part === process[index]));
  assert.deepEqual(
    segment.parts.map((part) => part.kind),
    ["activity", "activity", "message", "activity"],
  );
  assert.equal(segment.parts[1].items[0].message.id, "bash");
});

test("a Bash-only turn keeps one segment whether commands are expanded or not", () => {
  const entry = turn([
    message("user", "user", "Run"),
    tool("bash1", "Bash", { toolArgs: { command: "a" } }),
    tool("bash2", "Bash", { toolArgs: { command: "b" } }),
  ]);
  const process = projectTurnProcess(entry).process;
  assert.deepEqual(segmentTurnProcess(process, "command-first").map((s) => s.kind), ["run", "run"]);
  assert.deepEqual(segmentTurnProcess(process, "fully-folded").map((s) => s.kind), ["process"]);
});

test("an empty process segments to nothing in either mode", () => {
  assert.deepEqual(segmentTurnProcess([], "fully-folded"), []);
  assert.deepEqual(segmentTurnProcess([], "command-first"), []);
});

test("the turn header reports failure, stop, live and completion in that order", () => {
  const abortedMessage = {
    kind: "message",
    message: message("a", "assistant", "partial", { status: "aborted" }),
  };
  const abortedBash = {
    kind: "activity",
    items: [{
      kind: "tool",
      message: message("bash", "tool", "", {
        toolName: "Bash",
        status: "aborted",
      }),
    }],
  };
  const abortedThinking = {
    kind: "activity",
    items: [{
      kind: "thinking",
      message: message("think", "assistant", "", {
        thinking: "reasoning",
        status: "aborted",
      }),
    }],
  };
  for (const aborted of [abortedMessage, abortedBash, abortedThinking]) {
    // A recorded failure outranks a stop: the turn still ended without an answer.
    assert.deepEqual(
      turnProcessPhase({ parts: [aborted], isActive: false, failed: true }),
      { kind: "failed" },
    );
    assert.deepEqual(
      turnProcessPhase({ parts: [aborted], isActive: false, failed: false }),
      { kind: "stopped" },
    );
    // A stop also outranks a live runtime phase: the work was interrupted, not
    // still running.
    assert.deepEqual(
      turnProcessPhase({
        parts: [aborted],
        isActive: true,
        failed: false,
        activity: { phase: "compacting", since: 0 },
      }),
      { kind: "stopped" },
    );
  }
  assert.deepEqual(
    turnProcessPhase({
      parts: [{ kind: "message", message: message("b", "assistant", "done", { status: "complete" }) }],
      isActive: false,
      failed: false,
    }),
    { kind: "completed" },
  );
  // Running carries the runtime stage when the turn is live and not stopped.
  assert.deepEqual(
    turnProcessPhase({
      parts: [],
      isActive: true,
      failed: false,
      activity: { phase: "compacting", since: 0 },
    }),
    { kind: "running", phase: "compacting" },
  );
});

test("a failed child never turns a completed turn into failed or stopped", () => {
  const task = {
    kind: "activity",
    items: [{
      kind: "tool",
      message: message("task", "tool", "", {
        toolName: "Task",
        toolCallId: "call",
        status: "complete",
      }),
      delegate: {
        items: [{
          kind: "answer",
          message: message("child", "assistant", "", {
            parentToolCallId: "call",
            status: "aborted",
            error: { code: "TURN_ABORTED", message: "stopped" },
          }),
        }],
      },
    }],
  };
  assert.deepEqual(
    turnProcessPhase({ parts: [task], isActive: false, failed: false }),
    { kind: "completed" },
  );
  // A failed turn is still failed, independent of the child.
  assert.deepEqual(
    turnProcessPhase({ parts: [task], isActive: false, failed: true }),
    { kind: "failed" },
  );
  // The turn's own Task row being aborted is its own stop signal.
  const ownAborted = {
    ...task,
    items: [{ ...task.items[0], message: { ...task.items[0].message, status: "aborted" } }],
  };
  assert.deepEqual(
    turnProcessPhase({ parts: [ownAborted], isActive: false, failed: false }),
    { kind: "stopped" },
  );
});

test("the header count comes from the production activity summary", () => {
  const entry = turn([
    message("user", "user", "Run"),
    tool("read", "Read", { toolResult: "a" }),
    tool("bash1", "Bash", { toolArgs: { command: "a" } }),
    tool("bash2", "Bash", { toolArgs: { command: "b" } }),
    tool("grep", "Grep", { toolResult: "b" }),
  ]);
  const process = projectTurnProcess(entry).process;
  const items = process.flatMap((part) =>
    part.kind === "activity" ? part.items : [],
  );
  const summary = cachedActivitySummary(items);
  assert.equal(summary.tools, 4);
  assert.equal(summary.count, 4);
  assert.equal(summary.issues, 0);
  assert.equal(summary.label, "chat.activityTools");
  const bashOnly = turn([
    message("user", "user", "Run"),
    tool("bash1", "Bash", { toolArgs: { command: "a" } }),
    tool("bash2", "Bash", { toolArgs: { command: "b" } }),
  ]);
  const bashItems = projectTurnProcess(bashOnly).process.flatMap((part) =>
    part.kind === "activity" ? part.items : [],
  );
  assert.equal(cachedActivitySummary(bashItems).tools, 2);
  assert.equal(cachedActivitySummary(bashItems).label, "chat.activityCommands");
});

test("the shared process-step helper counts message rows and hides content-backed thinking", () => {
  const progress = {
    kind: "message",
    message: message("progress", "assistant", "Inspecting"),
  };
  // A message-only process is still visible: the disclosure needs a non-zero
  // step count even when no activity item exists.
  assert.equal(cachedVisibleProcessSteps([progress], true, false), 1);
  assert.equal(cachedVisibleProcessSteps([progress], true, true), 1);
  // A streaming assistant row with content counts its content only. The
  // reasoning beside it is hidden by the preference, so it adds no step.
  const streamingContentAndThinking = {
    kind: "message",
    message: message("answer", "assistant", "Visible answer", {
      thinking: "Reasoning with content",
      status: "streaming",
    }),
  };
  assert.equal(
    cachedVisibleProcessSteps([streamingContentAndThinking], true, true),
    1,
  );
  // A live reasoning-only row keeps its indicator; completed reasoning does not.
  const thinkingItem = {
    kind: "thinking",
    message: message("think", "assistant", "", {
      thinking: "Reasoning",
      status: "streaming",
    }),
  };
  assert.equal(
    cachedVisibleProcessSteps([{ kind: "activity", items: [thinkingItem] }], true, true),
    1,
  );
  assert.equal(
    cachedVisibleProcessSteps(
      [{ kind: "activity", items: [{ ...thinkingItem, message: { ...thinkingItem.message, status: "complete" } }] }],
      true,
      false,
    ),
    0,
  );
});


test("settings writes validate the thinking preference without changing other preferences", async () => {
  const { validateSettingsWrite } = await import("../src/lib/api.ts");
  const settings = {
    defaultMode: "agent",
    theme: "dark",
    enterToSend: true,
    onboardingDismissed: false,
  };
  assert.equal(validateSettingsWrite(settings), settings);
  const infiniteSettings = { ...settings, infiniteProviderRetry: true };
  assert.equal(validateSettingsWrite(infiniteSettings), infiniteSettings);
  assert.throws(
    () => validateSettingsWrite({ ...settings, infiniteProviderRetry: "yes" }),
    /infiniteProviderRetry is invalid/,
  );
  for (const showThinking of [true, false]) {
    const next = { ...settings, showThinking };
    assert.equal(validateSettingsWrite(next), next);
  }
  assert.throws(
    () => validateSettingsWrite({ ...settings, showThinking: "yes" }),
    /showThinking is invalid/,
  );
  // The legacy field is retained for persisted-settings compatibility.
  for (const thinkingDisplayMode of ["detailed", "compact"]) {
    const next = { ...settings, thinkingDisplayMode };
    assert.equal(validateSettingsWrite(next), next);
  }
  assert.throws(
    () => validateSettingsWrite({ ...settings, thinkingDisplayMode: "unknown" }),
    /thinkingDisplayMode is invalid/,
  );
});

test("all process chunks share a linear timing pass over one immutable turn snapshot", () => {
  let timestampReads = 0;
  const count = 2_000;
  const parts = Object.freeze(Array.from({ length: count }, (_, index) => ({
    kind: "activity",
    items: [Object.freeze({
      kind: "tool",
      message: Object.freeze({
        ...tool(`timed-${index}`, index % 2 ? "Bash" : "Read", { toolDurationMs: 10 }),
        get createdAt() {
          timestampReads += 1;
          return "2026-09-17T00:00:00.000Z";
        },
      }),
    })],
  })));
  const segments = segmentTurnProcess(parts).filter((segment) => segment.kind === "process");
  for (const _segment of segments) {
    assert.deepEqual(turnProcessTiming(parts), {
      startedAt: Date.parse("2026-09-17T00:00:00.000Z"),
      endedAt: Date.parse("2026-09-17T00:00:00.000Z") + 10,
    });
  }
  assert.ok(timestampReads <= count * 2, `one snapshot must be linear, read ${timestampReads} timestamps`);
  const updated = [...parts, { kind: "message", message: message("later", "assistant", "done", {
    createdAt: "2026-09-17T00:00:02.000Z", responseDurationMs: 50,
  }) }];
  assert.equal(turnProcessTiming(updated).endedAt, Date.parse("2026-09-17T00:00:02.050Z"));
  assert.equal(turnProcessTiming(parts).endedAt, Date.parse("2026-09-17T00:00:00.010Z"));
});

test("timing accepts a giant activity without an argument-spread limit", () => {
  const parts = [{
    kind: "activity",
    items: Array.from({ length: 150_000 }, (_, index) => ({
      kind: "tool", message: tool(`large-${index}`, "Grep", { toolDurationMs: index }),
    })),
  }];
  assert.equal(turnProcessTiming(parts).endedAt - turnProcessTiming(parts).startedAt, 149_999);
});
