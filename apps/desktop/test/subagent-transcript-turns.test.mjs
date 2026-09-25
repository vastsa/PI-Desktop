import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildSubagentTranscript } = await import(
  "../src/lib/subagent-transcript.ts"
);

function message(id, content, extra = {}) {
  return { id, content, ...extra };
}

function taskCall(id, task, extra = {}) {
  return message(id, "", {
    role: "tool",
    toolName: "Task",
    toolCallId: id,
    toolArgs: { task },
    ...extra,
  });
}

test("one Task call becomes one user turn followed by the delegate's rows", () => {
  const messages = [
    taskCall("call-1", "Find all call sites of resize()", {
      toolResult: { delegationId: "del-1" },
    }),
    message("step-1", "grep resize(", {
      role: "tool",
      parentToolCallId: "call-1",
      agentName: "explorer",
    }),
    message("note-1", "Found three call sites.", {
      role: "assistant",
      parentToolCallId: "call-1",
      thinking: "Check the header first.",
      agentName: "explorer",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.ok(transcript);
  assert.equal(transcript.agentName, "explorer");
  assert.equal(transcript.turns.length, 1);
  assert.equal(transcript.turns[0].task, "Find all call sites of resize()");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.kind),
    ["tool", "thinking", "answer"],
  );
});

test("a resumed delegation renders follow-up prompts as further user turns", () => {
  const messages = [
    taskCall("call-1", "First prompt", {
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "First answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-2", "Second answer.", {
      role: "assistant",
      parentToolCallId: "call-2",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, "First prompt");
  assert.deepEqual(
    transcript.turns[0].rows.map((row) => row.message.id),
    ["answer-1"],
  );
  assert.equal(transcript.turns[1].task, "Follow-up prompt");
  assert.deepEqual(
    transcript.turns[1].rows.map((row) => row.message.id),
    ["answer-2"],
  );
});

test("a chain is recognized from either end of the resume links", () => {
  // Only the resumed call carries the result payload; the original call is
  // linked backward through the runtime's resume record.
  const messages = [
    taskCall("call-1", "Original prompt"),
    taskCall("call-2", "Follow-up prompt", {
      toolArgs: { task: "Follow-up prompt", resume: "call-1" },
      toolResult: { delegationId: "del-1" },
    }),
    message("answer-1", "Original answer.", {
      role: "assistant",
      parentToolCallId: "call-1",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns.length, 2);
  assert.equal(transcript.turns[0].task, "Original prompt");
});

test("parallel delegates never mix into each other's turns", () => {
  const messages = [
    taskCall("call-a", "Task A", {
      toolResult: { delegationId: "del-a" },
    }),
    taskCall("call-b", "Task B", {
      toolResult: { delegationId: "del-b" },
    }),
    message("answer-a", "Answer A.", {
      role: "assistant",
      parentToolCallId: "call-a",
      agentName: "explorer",
    }),
    message("answer-b", "Answer B.", {
      role: "assistant",
      parentToolCallId: "call-b",
      agentName: "reviewer",
    }),
  ];
  const a = buildSubagentTranscript(messages, "del-a");
  const b = buildSubagentTranscript(messages, "del-b");
  assert.equal(a.agentName, "explorer");
  assert.deepEqual(
    a.turns.flatMap((turn) => turn.rows.map((row) => row.message.id)),
    ["answer-a"],
  );
  assert.equal(b.agentName, "reviewer");
  assert.deepEqual(
    b.turns.flatMap((turn) => turn.rows.map((row) => row.message.id)),
    ["answer-b"],
  );
});

test("an unknown delegation id yields no transcript", () => {
  const messages = [taskCall("call-1", "Task", {
    toolResult: { delegationId: "del-1" },
  })];
  assert.equal(buildSubagentTranscript(messages, "missing"), null);
  assert.equal(buildSubagentTranscript(messages, ""), null);
});

test("a call with no task argument degrades to an empty prompt", () => {
  const messages = [
    message("call-1", "", {
      role: "tool",
      toolName: "Task",
      toolCallId: "call-1",
      toolArgs: {},
      toolResult: { delegationId: "del-1" },
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "del-1");
  assert.equal(transcript.turns[0].task, "");
});
