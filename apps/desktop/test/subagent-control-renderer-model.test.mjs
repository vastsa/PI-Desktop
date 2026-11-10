import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildSessionSubagents } = await import("../src/features/subagents/model.ts");
const { buildSubagentTranscript } = await import("../src/lib/subagent-transcript.ts");
const { subagentMessageModelChoices, subagentModelChoices } = await import("../src/components/settings/subagent-models.ts");

const stamp = (n) => new Date(Date.UTC(2026, 10, 3, 0, 0, n)).toISOString();
const start = (operationId, delegationId, extra = {}) => ({
  id: `user-subagent-${operationId}`, role: "user", content: `Task ${operationId}`,
  createdAt: stamp(0), status: "complete", parentToolCallId: `user-subagent-${operationId}`,
  agentName: "explorer", subagentControl: {
    operationId, requestHash: "a".repeat(64), action: "start", delegationId,
    agent: "explorer", status: "completed", modelId: "fixture-model", ...extra,
  },
});

test("user-owned roots appear in the directory without mutating or duplicating real user rows", () => {
  const root = start("first", "delegate-first");
  const rows = [root, { id: "parent", role: "user", content: "Parent prompt", createdAt: stamp(1) }];
  const before = JSON.stringify(rows);
  const agents = buildSessionSubagents(rows, false);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].delegationId, "delegate-first");
  assert.equal(agents[0].task, "Task first");
  assert.equal(agents[0].status, "completed");
  assert.equal(JSON.stringify(rows), before);
  assert.equal(root.role, "user");
  assert.equal(root.toolName, undefined);
});

test("direct messages and resumed user roots form one attributed conversation", () => {
  const first = start("first", "delegate-first");
  const message = {
    id: "user-subagent-direction", role: "user", content: "Only inspect the owned file",
    createdAt: stamp(1), parentToolCallId: first.id, agentName: "explorer",
    subagentControl: { operationId: "direction", requestHash: "b".repeat(64),
      action: "message", delegationId: "delegate-first", agent: "explorer" },
  };
  const answer = { id: "answer", role: "assistant", content: "Owned-file report", createdAt: stamp(2),
    parentToolCallId: first.id, agentName: "explorer" };
  const resume = { ...start("resume", "delegate-resume", { resume: "delegate-first", status: "running" }), createdAt: stamp(3) };
  const rows = [first, message, answer, resume,
    { id: "other", role: "user", content: "Unrelated parent input", createdAt: stamp(4) }];
  const directory = buildSessionSubagents(rows, true);
  assert.equal(directory.length, 1);
  assert.equal(directory[0].delegationId, "delegate-resume");
  const transcript = buildSubagentTranscript(rows, "delegate-resume");
  assert.deepEqual(transcript.turns.map((turn) => turn.task), ["Task first", "Task resume"]);
  assert.deepEqual(transcript.turns[0].rows.map((row) => [row.kind, row.message.content]), [
    ["user", "Only inspect the owned file"], ["answer", "Owned-file report"],
  ]);
  assert.equal(transcript.turns[1].rows.length, 0);
});

test("legacy Task calls and direct user continuations retain one chain", () => {
  const legacy = { id: "legacy", role: "tool", content: "", createdAt: stamp(0),
    toolName: "Task", toolCallId: "call-legacy", toolArgs: { agent: "explorer", task: "Legacy task" },
    toolResult: { details: { delegationId: "delegate-legacy", status: "completed" } } };
  const resume = { ...start("resume", "delegate-resume", { resume: "delegate-legacy" }), createdAt: stamp(1) };
  assert.equal(buildSessionSubagents([legacy, resume], false).length, 1);
  assert.deepEqual(buildSubagentTranscript([legacy, resume], "delegate-resume").turns.map((turn) => turn.task),
    ["Legacy task", "Task resume"]);
});

test("message model choices require opt-in without restricting definition model pins", () => {
  const provider = { id: "fixture", name: "Fixture", vendorKey: "custom", enabled: true,
    authKind: "none", hasSecret: false, api: "openai-completions", baseUrl: "http://127.0.0.1:1",
    defaultModelId: "enabled", models: [{ id: "enabled", availableForSubagents: true }, { id: "not-enabled" }],
    createdAt: stamp(0), updatedAt: stamp(0) };
  assert.deepEqual(subagentMessageModelChoices([provider]).map((choice) => choice.modelId), ["enabled"]);
  assert.equal(subagentModelChoices([provider]).length, 2);
  assert.equal(subagentMessageModelChoices([{ ...provider, enabled: false }]).length, 0);
});

test("a rejected Task resume cannot clear the original model or replace its usable delegation id", () => {
  const original = { id: "original", role: "tool", content: "", createdAt: stamp(0),
    toolName: "Task", toolCallId: "original-call", toolArgs: { agent: "explorer", task: "Original task" },
    toolStatus: "success", toolResult: { details: { delegationId: "original-id", modelId: "retained-model", status: "completed" } } };
  const failed = { id: "failed", role: "tool", content: "", createdAt: stamp(1),
    toolName: "Task", toolCallId: "failed-call", toolArgs: { agent: "explorer", task: "Continue", resume: "original-id" },
    toolStatus: "error", isError: true, toolResult: { details: { error: "Recorded model unavailable" } } };
  const directory = buildSessionSubagents([original, failed], false);
  const chain = directory.find(item => item.calls.some(call => call.id === original.id));
  assert.equal(chain.modelId, "retained-model");
  assert.equal(chain.delegationId, "original-id");
  assert.equal(chain.status, "completed");
  assert(directory.some(item => item.calls.some(call => call.id === failed.id)), "Rejected attempt remains visible");
});
