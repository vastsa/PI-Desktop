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
  visibleProcessSteps,
  turnProcessTiming,
} = await import("../src/lib/turn-process.ts");

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
  assert.equal(visibleProcessSteps(projected.process, false, false), 5);
  assert.equal(visibleProcessSteps(projected.process, true, false), 4);
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
  assert.equal(visibleProcessSteps(entry.parts, true, true), 1);
  assert.equal(visibleProcessSteps(entry.parts, true, false), 0);
  const withAnswer = turn([{ ...thinking, content: "Answer" }]);
  assert.equal(
    visibleProcessSteps(projectTurnProcess(withAnswer).process, true, true),
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
  const segments = segmentTurnProcess(projectTurnProcess(entry).process);
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
  const segments = segmentTurnProcess(projectTurnProcess(entry).process);
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
  const segments = segmentTurnProcess(projectTurnProcess(entry).process);
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
