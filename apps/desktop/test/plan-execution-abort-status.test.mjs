import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// A turn the user aborted must not be recorded as a completed plan execution.
//
// pi emits `agent_end` immediately after an `error` event. Both handlers derive
// the execution id from `pendingExecutionFinishes`, and the error handler used to
// populate that map only after an async finalizer resolved. The `agent_end`
// handler therefore saw an empty map, settled the execution as `completed`, and
// the later `interrupted` write lost both the first-writer-wins guard and
// `finish_execution`'s conflict check in the host — leaving a user-aborted plan
// in the execution history as if it had finished.
//
// These assertions pin the ordering, not the surrounding machinery: the status
// claim must happen synchronously, before `finishTurn` is awaited.

const source = await readFile(
  new URL("../electron/main/runtime/event-persistence.ts", import.meta.url),
  "utf8",
);

test("the error handler claims the interrupted status before the async finalizer", () => {
  const errorBranchAt = source.indexOf('if (event.type === "error") {');
  assert.ok(errorBranchAt > 0, "the error branch should exist");

  const branch = source.slice(errorBranchAt, errorBranchAt + 2000);
  const claimAt = branch.indexOf("pendingExecutionFinishes.set(executionId");
  const finalizeAt = branch.indexOf("const turnFinalization = finishTurn(");

  assert.ok(claimAt > 0, "the error branch must claim the status in the map");
  assert.ok(finalizeAt > 0, "the error branch should still finalize the turn");
  assert.ok(
    claimAt < finalizeAt,
    "the claim must precede finishTurn; otherwise agent_end settles the execution first",
  );
  assert.match(branch, /status: "interrupted"/);
});

test("the claim carries the abort code so the history explains itself", () => {
  const errorBranchAt = source.indexOf('if (event.type === "error") {');
  const branch = source.slice(errorBranchAt, errorBranchAt + 2000);
  assert.match(branch, /errorCode: event\.error\.code/);
});

test("agent_end still settles a normal execution as completed", () => {
  const agentEndAt = source.indexOf('if (event.type === "agent_end") {');
  assert.ok(agentEndAt > 0);
  const branch = source.slice(agentEndAt, agentEndAt + 1200);
  // Unchanged: a run that reaches agent_end without a prior error is complete.
  assert.match(branch, /finishApprovedExecution\(executionId, "completed"\)/);
});

test("the execution id derivation refuses an already-interrupted execution", () => {
  // This is the guard that makes the synchronous claim effective: once the map
  // says interrupted, agent_end gets no executionId and cannot overwrite it.
  const deriveAt = source.indexOf("const executionId = (() => {");
  assert.ok(deriveAt > 0);
  const block = source.slice(deriveAt, deriveAt + 600);
  assert.match(block, /pendingExecutionFinishes\.get\(candidate\)\?\.status === "interrupted"/);
  assert.match(block, /return undefined;/);
});
