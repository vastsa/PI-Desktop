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
const { projectTurnProcess, segmentTurnProcess } = await import("../src/lib/turn-process.ts");

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
   transcript.turns[0].reply.parts.flatMap((part) => part.kind === "activity" ? part.items.map((item) => item.kind) : ["answer"]),
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
   transcript.turns[0].messages.map((message) => message.id),
    ["answer-1"],
  );
  assert.equal(transcript.turns[1].task, "Follow-up prompt");
  assert.deepEqual(
   transcript.turns[1].messages.map((message) => message.id),
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
   a.turns.flatMap((turn) => turn.messages.map((message) => message.id)),
    ["answer-a"],
  );
  assert.equal(b.agentName, "reviewer");
  assert.deepEqual(
   b.turns.flatMap((turn) => turn.messages.map((message) => message.id)),
    ["answer-b"],
  );
});

test("nested tools stay with their owning delegate, not their tool parent", () => {
  const messages = [
    taskCall("task-1", "Inspect files", { toolResult: { delegationId: "delegate-1" } }),
    message("root-read", "root result", {
      role: "tool", toolName: "Read", nestedParentToolCallId: "root-code",
    }),
    message("code-1", "running", {
      role: "tool", toolName: "codemode", parentToolCallId: "task-1", agentName: "reader",
    }),
    message("nested-read", "delegate result", {
      role: "tool", toolName: "Read", parentToolCallId: "task-1",
      nestedParentToolCallId: "code-1", agentName: "reader",
    }),
  ];
  const transcript = buildSubagentTranscript(messages, "delegate-1");
  assert.equal(transcript.agentName, "reader");
 assert.deepEqual(transcript.turns[0].messages.map((message) => message.id), ["code-1", "nested-read"]);
 assert.equal(transcript.turns[0].messages[1].nestedParentToolCallId, "code-1");
  assert.equal(buildSubagentTranscript(messages, "root-code"), null);
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

test("a delegation turn uses the shared process layout and keeps its answer separate", () => {
  const child = { parentToolCallId: "task-1", turnId: "parent-turn" };
  const messages = [
    taskCall("task-1", "Inspect files", { toolResult: { delegationId: "delegate-1" } }),
    message("think", "", { ...child, role: "assistant", thinking: "Check the files." }),
    message("read", "a file", { ...child, role: "tool", toolName: "Read" }),
    message("run", "command output", { ...child, role: "tool", toolName: "Bash" }),
    message("progress", "One more check.", { ...child, role: "assistant" }),
    message("grep", "another file", { ...child, role: "tool", toolName: "Grep" }),
    message("answer", "Done.", { ...child, role: "assistant" }),
  ];
  const { turns: [turn] } = buildSubagentTranscript(messages, "delegate-1");
  assert.equal(turn.reply.id, "task-1");
  const { process, responses } = projectTurnProcess(turn.reply);
  assert.deepEqual(responses.map((part) => part.message.id), ["answer"]);
  assert.ok(process.some((part) => part.kind === "message" && part.message.id === "progress"));
  assert.deepEqual(segmentTurnProcess(process, "flat").map((segment) => segment.kind), ["process"]);
  assert.deepEqual(segmentTurnProcess(process, "command-first").map((segment) => segment.kind), ["process", "run", "process"]);
  assert.deepEqual(segmentTurnProcess(process, "fully-folded").map((segment) => segment.kind), ["process"]);
});
