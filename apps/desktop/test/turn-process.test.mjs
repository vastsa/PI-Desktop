import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { formatMessageTimestamp } = await import("../src/lib/message-timestamp.ts");
const {
  processContainsMessage,
  projectTurnProcess,
  visibleProcessSteps,
  resolveThinkingDisplayMode,
  isLastActivityPart,
  shouldAutoOpenTurnProcess,
  shouldGroupTurnProcess,
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

test("one turn groups thinking, tools and progress while retaining only the trailing answer", () => {
  const entry = turn([
    message("user", "user", "Inspect"),
    message("intro", "assistant", "I will inspect", { thinking: "Plan" }),
    message("read", "tool", "result", { toolName: "Read" }),
    message("progress", "assistant", "I found the cause"),
    message("edit", "tool", "updated", { toolName: "Edit" }),
    message("final", "assistant", "Fixed"),
  ]);
  const projected = projectTurnProcess(entry);
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["final"],
  );
  assert.equal(visibleProcessSteps(projected.process, "detailed", false), 5);
  assert.equal(visibleProcessSteps(projected.process, "compact", false), 4);
});

test("steering is always process content and the trailing assistant answer stays outside", () => {
  const entry = turn([
    message("root", "user", "Inspect", {
      createdAt: "2026-09-17T00:00:00.000Z",
    }),
    message("intro", "assistant", "Starting", {
      createdAt: "2026-09-17T00:00:01.000Z",
    }),
    message("read", "tool", "result", {
      toolName: "Read",
      createdAt: "2026-09-17T00:00:02.000Z",
    }),
    message("steer", "user", "Also inspect tests", {
      steering: true,
      createdAt: "2026-09-17T00:00:03.000Z",
    }),
    message("edit", "tool", "updated", {
      toolName: "Edit",
      createdAt: "2026-09-17T00:00:04.000Z",
    }),
    message("final", "assistant", "Fixed", {
      createdAt: "2026-09-17T00:00:05.000Z",
      responseDurationMs: 1000,
    }),
  ]);
  const projected = projectTurnProcess(entry);

  assert.deepEqual(
    projected.process.map((part) => part.kind),
    ["message", "activity", "steering", "activity"],
  );
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["final"],
  );
  assert.equal(visibleProcessSteps(projected.process, "detailed", false), 4);
  assert.equal(processContainsMessage(projected.process, "steer"), true);
  assert.deepEqual(turnProcessTiming(entry.parts, entry.startedAt), {
    startedAt: Date.parse("2026-09-17T00:00:00.000Z"),
    endedAt: Date.parse("2026-09-17T00:00:06.000Z"),
  });
});

test("a trailing steering bubble cannot be projected as an assistant response", () => {
  const entry = turn([
    message("root", "user", "Inspect"),
    message("progress", "assistant", "Working"),
    message("steer", "user", "One more constraint", { steering: true }),
  ]);
  const projected = projectTurnProcess(entry);

  assert.equal(projected.responses.length, 0);
  assert.deepEqual(
    projected.process.map((part) => part.kind),
    ["message", "steering"],
  );
});

test("streamed text stays readable until later work establishes it as progress", () => {
  const text = message("text", "assistant", "Inspecting", { status: "streaming" });
  assert.equal(projectTurnProcess(turn([text])).responses[0].message, text);
  const projected = projectTurnProcess(
    turn([text, message("tool", "tool", "", { toolName: "Read" })]),
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
    turn([error, message("tool", "tool", "result"), partial]),
  );
  assert.deepEqual(
    projected.responses.map((part) => part.message.id),
    ["error", "partial"],
  );
});

test("compact thinking disappears after reasoning ends without removing stored data", () => {
  const thinking = message("think", "assistant", "", {
    thinking: "Private reasoning",
    status: "streaming",
  });
  const entry = turn([thinking]);
  assert.equal(visibleProcessSteps(entry.parts, "compact", true), 1);
  assert.equal(visibleProcessSteps(entry.parts, "compact", false), 0);
  const withAnswer = turn([{ ...thinking, content: "Answer" }]);
  assert.equal(
    visibleProcessSteps(projectTurnProcess(withAnswer).process, "compact", true),
    0,
  );
  assert.equal(thinking.thinking, "Private reasoning");
});

test("compact completed hosted search remains a visible process step", () => {
  const search = {
    kind: "hostedSearch",
    message: message("search", "assistant", "", { status: "complete" }),
  };
  const parts = [{ kind: "activity", items: [search] }];
  assert.equal(visibleProcessSteps(parts, "compact", false), 1);
  parts[0].items.push({
    kind: "tool",
    message: message("read", "tool", "result", { toolName: "Read" }),
  });
  assert.equal(visibleProcessSteps(parts, "compact", false), 2);
});

test("missing and unknown display settings retain detailed mode", () => {
  for (const value of [undefined, null, "hidden", false, "detailed"]) {
    assert.equal(resolveThinkingDisplayMode(value), "detailed");
  }
  assert.equal(resolveThinkingDisplayMode("compact"), "compact");
});

test("both modes group turns and only automatically show active work", () => {
  assert.equal(shouldGroupTurnProcess("detailed"), true);
  assert.equal(shouldGroupTurnProcess("compact"), true);
  for (const mode of ["detailed", "compact"]) {
    assert.equal(shouldAutoOpenTurnProcess(mode, false, false), false);
    assert.equal(shouldAutoOpenTurnProcess(mode, true, false), true);
    assert.equal(shouldAutoOpenTurnProcess(mode, true, true), true);
    assert.equal(shouldAutoOpenTurnProcess(mode, false, true), false);
  }
});

test("the last activity part owns detailed-mode's default-open tool", () => {
  const entry = turn([
    message("intro", "assistant", "Inspect", { thinking: "Plan" }),
    message("read", "tool", "result", { toolName: "Read" }),
    message("progress", "assistant", "Next"),
    message("edit", "tool", "updated", { toolName: "Edit" }),
    message("final", "assistant", "Fixed"),
  ]);
  const activities = entry.parts.filter((part) => part.kind === "activity");
  assert.ok(activities.length >= 2);
  assert.equal(isLastActivityPart(entry.parts, activities[0]), false);
  assert.equal(isLastActivityPart(entry.parts, activities.at(-1)), true);
  assert.equal(
    isLastActivityPart(
      entry.parts,
      entry.parts.find((part) => part.kind === "message"),
    ),
    false,
  );
});

test("turn timing starts at the user request and falls back to loaded process rows", () => {
  const entry = turn([
    message("user", "user", "Inspect", {
      createdAt: "2026-09-17T00:00:00.000Z",
    }),
    message("read", "tool", "", {
      createdAt: "2026-09-17T00:00:01.000Z",
      toolCompletedAt: "2026-09-17T00:00:02.000Z",
    }),
    message("answer", "assistant", "Done", {
      createdAt: "2026-09-17T00:00:03.000Z",
      responseDurationMs: 1000,
    }),
  ]);
  const timing = turnProcessTiming(entry.parts, entry.startedAt);
  assert.equal(timing.endedAt - timing.startedAt, 4000);

  const paged = turn([
    message("answer", "assistant", "Done", {
      createdAt: "2026-09-17T00:00:03.000Z",
      responseDurationMs: 1000,
    }),
  ]);
  assert.deepEqual(turnProcessTiming(paged.parts, paged.startedAt), {
    startedAt: Date.parse("2026-09-17T00:00:03.000Z"),
    endedAt: Date.parse("2026-09-17T00:00:04.000Z"),
  });

  const invalidUser = turn([
    message("user", "user", "Inspect", { createdAt: "bad" }),
    message("answer", "assistant", "Done", {
      createdAt: "2026-09-17T00:00:03.000Z",
    }),
  ]);
  assert.equal(
    turnProcessTiming(invalidUser.parts, invalidUser.startedAt).startedAt,
    Date.parse("2026-09-17T00:00:03.000Z"),
  );
  assert.deepEqual(
    turnProcessTiming(
      turn([message("bad", "assistant", "x", { createdAt: "bad" })]).parts,
      "bad",
    ),
    { startedAt: undefined, endedAt: undefined },
  );
});

test("message timestamps use locale formatting and reject invalid dates", () => {
  const value = "2026-09-17T13:45:00.000Z";
  assert.deepEqual(formatMessageTimestamp(value, "en-US"), {
    dateTime: value,
    label: new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value)),
  });
  assert.notEqual(
    formatMessageTimestamp(value, "en-US").label,
    formatMessageTimestamp(value, "de-DE").label,
  );
  assert.equal(formatMessageTimestamp("not-a-date", "en-US"), undefined);
  assert.deepEqual(formatMessageTimestamp(Date.parse(value), "en-US"), {
    dateTime: value,
    label: formatMessageTimestamp(value, "en-US").label,
  });
  assert.equal(formatMessageTimestamp(undefined, "en-US"), undefined);
});

test("user boundaries retain independent processes and delegation details stay attached", () => {
  const entries = buildTranscriptEntries([
    message("u1", "user", "one"),
    message("task", "tool", "started", { toolName: "Task", toolCallId: "call" }),
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

test("settings writes validate the mode without changing other preferences", async () => {
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
  for (const thinkingDisplayMode of ["detailed", "compact"]) {
    const next = { ...settings, thinkingDisplayMode };
    assert.equal(validateSettingsWrite(next), next);
  }
  assert.throws(
    () => validateSettingsWrite({ ...settings, thinkingDisplayMode: "unknown" }),
    /thinkingDisplayMode is invalid/,
  );
});

test("settling the process changes identity without remounting the subtree", async () => {
  const source = await readFile(
    new URL("../src/features/chat/transcript/TurnProcess.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /key=\{phase\}/);
  assert.match(source, /identity=\{disclosureKey\("turn", turnId, phase\)\}/);
  assert.match(source, /timing=\{processTiming\}|timing: TurnProcessTiming/);
  assert.match(source, /const summary = useMemo\(/);
});
