import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// A plan execution the user stopped must be recorded as `interrupted`, never
// `completed`.
//
// A user abort emits no error event at all: it locks the abort reason and lets
// `agent_end` land, and `agent_end` unconditionally settled the execution as
// `completed`. Observed in a real session — abort at 02:25:55, turn row
// `aborted`, execution_state `completed`, the two records disagreeing about the
// same event.
//
// `finishTurn` is the single funnel every end path passes through and it already
// freezes the abort-aware reason, so the execution is claimed there,
// synchronously, before any await.

const source = await readFile(
  new URL("../electron/main/runtime/event-persistence.ts", import.meta.url),
  "utf8",
);
const plansSource = await readFile(
  new URL("../electron/main/runtime/plans.ts", import.meta.url),
  "utf8",
);

const finishTurnBody = (() => {
  const at = plansSource.indexOf("function finishTurn(");
  assert.ok(at > 0, "finishTurn should exist");
  return plansSource.slice(at, at + 4200);
})();

test("finishTurn claims the execution from the frozen abort-aware reason", () => {
  const reasonAt = finishTurnBody.indexOf("const reason = peekAbortReason");
  const claimAt = finishTurnBody.indexOf("pendingExecutionFinishes.set(executionId");
  const awaitAt = finishTurnBody.indexOf("const runFinalization = async");

  assert.ok(reasonAt > 0, "finishTurn reads the frozen reason");
  assert.ok(claimAt > 0, "finishTurn must claim the execution settlement");
  assert.ok(reasonAt < claimAt, "the claim must read the frozen reason first");
  assert.ok(
    claimAt < awaitAt,
    "the claim must be synchronous: a later agent_end would otherwise win the first-writer-wins guard",
  );
});

test("the claim only settles this turn's own execution", () => {
  assert.match(finishTurnBody, /approvedExecutionIdsBySession\.get\(id\)/);
  assert.match(finishTurnBody, /approvedExecutionTurns\.get\(executionId\)\?\.turnId/);
  assert.match(finishTurnBody, /executionTurnId === turnId/);
});

test("the claim never emits a status finish_execution rejects", () => {
  // host-core accepts only `completed` and `interrupted`. hostTurnStatus maps an
  // erroring turn to `failed`, which finish_execution rejects outright.
  const claimBlock = finishTurnBody.slice(
    finishTurnBody.indexOf("pendingExecutionFinishes.set(executionId"),
  );
  assert.match(
    claimBlock,
    /status: reason === "completed" \? "completed" : "interrupted"/,
  );
  assert.ok(
    !/status: hostTurnStatus\(reason\)/.test(claimBlock),
    "hostTurnStatus maps error to `failed`, which finish_execution rejects",
  );
});

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

test("agent_end still settles a run with no claimed execution as completed", () => {
  const agentEndAt = source.indexOf('if (event.type === "agent_end") {');
  assert.ok(agentEndAt > 0);
  const branch = source.slice(agentEndAt, agentEndAt + 1200);
  // Unchanged fallback: a run that reaches agent_end with nothing claimed in the
  // map is complete. A claimed (aborted) execution never gets here, because the
  // derivation below returns no execution id for it.
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
