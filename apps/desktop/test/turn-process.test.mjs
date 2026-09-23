import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const {
  isInterimNarration,
  isTurnComplete,
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

test("missing and unknown display settings retain detailed mode", () => {
  for (const value of [undefined, null, "hidden", false, "detailed"]) {
    assert.equal(resolveThinkingDisplayMode(value), "detailed");
  }
  assert.equal(resolveThinkingDisplayMode("compact"), "compact");
});

test("a completed turn folds, and only compact auto-opens active failures", () => {
  assert.equal(shouldGroupTurnProcess("detailed"), true);
  assert.equal(shouldGroupTurnProcess("compact"), true);
  const detailed = (turnComplete) =>
    shouldAutoOpenTurnProcess("detailed", {
      isActive: false,
      hasToolFailure: false,
      turnComplete,
    });
  assert.equal(detailed(false), true);
  assert.equal(detailed(true), false);
  // A failure keeps the fallback too, so the issue count stays reachable.
  assert.equal(
    shouldAutoOpenTurnProcess("detailed", {
      isActive: false,
      hasToolFailure: true,
      turnComplete: true,
    }),
    false,
  );
  assert.equal(
    shouldAutoOpenTurnProcess("compact", {
      isActive: false,
      hasToolFailure: false,
      turnComplete: false,
    }),
    false,
  );
  assert.equal(
    shouldAutoOpenTurnProcess("compact", {
      isActive: true,
      hasToolFailure: false,
      turnComplete: false,
    }),
    false,
  );
  assert.equal(
    shouldAutoOpenTurnProcess("compact", {
      isActive: true,
      hasToolFailure: true,
      turnComplete: false,
    }),
    true,
  );
  assert.equal(
    shouldAutoOpenTurnProcess("compact", {
      isActive: false,
      hasToolFailure: true,
      turnComplete: true,
    }),
    false,
  );
});

test("only a turn that left flight with a recorded success counts as complete", () => {
  const answer = (extra) => message("final", "assistant", "Done", extra);
  assert.equal(isTurnComplete({ isRunning: false, answer: answer({ status: "complete" }) }), true);
  // A running turn never folds, however complete its last message looks: the
  // runtime records `complete` for a message that stopped on a tool call too.
  assert.equal(isTurnComplete({ isRunning: true, answer: answer({ status: "complete" }) }), false);
  assert.equal(isTurnComplete({ isRunning: false, answer: answer({}) }), false);
  assert.equal(isTurnComplete({ isRunning: false, answer: undefined }), false);
  assert.equal(
    isTurnComplete({ isRunning: false, answer: answer({ status: "aborted" }) }),
    false,
  );
  assert.equal(
    isTurnComplete({
      isRunning: false,
      answer: answer({ status: "error", error: { code: "INTERNAL", message: "failed" } }),
    }),
    false,
  );
  assert.equal(
    isTurnComplete({
      isRunning: false,
      answer: message("final", "assistant", "", { status: "complete" }),
    }),
    false,
  );
});

/*
 * Interim narration is presentation, not projection: the trailing candidate is
 * still the answer candidate either way, but while the turn is running and
 * earlier work exists it reads as work in progress rather than as the answer.
 */
test("only a running turn's streaming candidate over earlier work is interim narration", () => {
  const live = (extra = {}) =>
    message("live", "assistant", "Reading the log", {
      status: "streaming",
      ...extra,
    });
  const interim = (messages, options = {}) => {
    const projected = projectTurnProcess(turn(messages));
    return isInterimNarration({
      isRunning: options.isRunning ?? true,
      answer: projected.responses.at(-1)?.message,
      processParts: projected.process,
      mode: options.mode ?? "detailed",
      isActive: options.isActive ?? true,
    });
  };
  const prompt = message("user", "user", "Inspect");
  const read = message("read", "tool", "result", { toolName: "Read" });
  assert.equal(interim([prompt, read, live()]), true);
  // The turn-level running state decides: a reader inside the reading window
  // does not strip the presentation from a turn that is still working.
  assert.equal(interim([prompt, read, live()], { isActive: false }), true);
  // Compact hides the reasoning it keeps, not the work the narration follows:
  // the same gate that decides whether the process group renders at all.
  assert.equal(
    interim([prompt, read, live()], { mode: "compact", isActive: false }),
    true,
  );
  // Once the turn is out of flight, the same text is the answer.
  assert.equal(interim([prompt, read, live()], { isRunning: false }), false);
  // Reasoning alone is the ordinary path, not work between narration and answer.
  assert.equal(
    interim([
      prompt,
      message("think", "assistant", "", { thinking: "Weighing options" }),
      live(),
    ]),
    false,
  );
  // A hosted-search round is work of the same kind as a tool call.
  assert.equal(
    interim([
      prompt,
      message("search", "assistant", "", {
        hostedSearch: {
          status: "completed",
          rounds: [
            { id: "round-1", status: "completed", query: "pi", sources: [] },
          ],
        },
      }),
      live(),
    ]),
    true,
  );
  // A settled, aborted, failed or still-empty candidate is not narration.
  assert.equal(
    interim([
      prompt,
      read,
      message("live", "assistant", "Done", { status: "complete" }),
    ]),
    false,
  );
  assert.equal(
    interim([
      prompt,
      read,
      message("live", "assistant", "Half", { status: "aborted" }),
    ]),
    false,
  );
  assert.equal(
    interim([
      prompt,
      read,
      message("live", "assistant", "Half", {
        status: "streaming",
        error: { code: "INTERNAL", message: "failed" },
      }),
    ]),
    false,
  );
  assert.equal(
    interim([
      prompt,
      read,
      message("live", "assistant", "   ", { status: "streaming" }),
    ]),
    false,
  );
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

test("history timing uses recorded ends and rejects invalid timestamps and durations", () => {
  const entry = turn([
    message("read", "tool", "", { toolCompletedAt: "2026-09-17T00:00:02.000Z" }),
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
