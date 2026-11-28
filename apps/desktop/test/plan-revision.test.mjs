import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createQueueSlice } = await import("../src/stores/slices/queue-slice.ts");
const { pendingRevisionPlan } = await import("../src/lib/plan-mode-state.ts");

function fixture(t) {
  const plan = { id: "p1", sessionId: "s1", turnId: "t1", toolCallId: "c1", version: 1, kind: "plan", status: "pending" };
  const resolution = Promise.withResolvers();
  const state = {
    sessions: [{ id: "s1", mode: "plan" }], activeSessionId: "s1", runningSessions: {},
    pendingPlans: { s1: plan }, planCheckpoints: { s1: plan },
    resolvePlan: t.mock.fn(() => resolution.promise), sendPrompt: t.mock.fn(async () => true),
    showToast: t.mock.fn(),
  };
  const { sendPlanRevision } = createQueueSlice({ get: () => state });
  return { state, plan, resolution, send: () => sendPlanRevision(plan, "Remove step two") };
}

test("sending twice rejects the displayed checkpoint once and delivers to its original session", async t => {
  const { state, plan, resolution, send } = fixture(t);
  const first = send();
  assert.equal(await send(), false);
  assert.deepEqual(state.resolvePlan.mock.calls.map(call => call.arguments[0]), [
    { proposalId: "p1", sessionId: "s1", turnId: "t1", toolCallId: "c1", version: 1, action: "reject" },
  ]);
  assert.equal(state.sendPrompt.mock.callCount(), 0);
  state.activeSessionId = "s2";
  resolution.resolve({ state: "planning", proposal: { ...plan, status: "rejected" } });
  assert.equal(await first, true);
  assert.deepEqual(state.sendPrompt.mock.calls[0].arguments, ["Remove step two", undefined, "s1"]);
});

test("a winning approval, stale checkpoint, or failed rejection keeps revision text out of execution", async t => {
  for (const outcome of ["approved", "replaced", "failed"]) {
    const { state, plan, resolution, send } = fixture(t);
    const sending = send();
    if (outcome === "replaced") state.planCheckpoints.s1 = { ...plan, id: "p2" };
    if (outcome === "failed") resolution.reject(new Error("unavailable"));
    else resolution.resolve({ state: outcome === "approved" ? "inactive" : "planning",
      proposal: { ...plan, status: outcome === "approved" ? "approved" : "rejected" } });
    assert.equal(await sending, false, outcome);
    assert.equal(state.sendPrompt.mock.callCount(), 0, outcome);
  }
});

test("a still-finishing submission leaves the first plan pending and the draft available", async t => {
  const { state, send } = fixture(t);
  state.runningSessions.s1 = true;
  assert.equal(await send(), false);
  assert.equal(state.resolvePlan.mock.callCount(), 0);
});

test("only the current editable local Plan checkpoint can be revised", async t => {
  const { state, plan, send } = fixture(t);
  const session = state.sessions[0];
  assert.equal(pendingRevisionPlan(session, plan, plan), plan);
  for (const [target, checkpoint, pending] of [
    [undefined, plan, plan],
    [{ ...session, mode: "agent" }, plan, plan],
    [{ ...session, source: "pi-native" }, plan, plan],
    [{ ...session, source: "remote" }, plan, plan],
    [{ ...session, capabilities: { canPrompt: false } }, plan, plan],
    [session, { ...plan, kind: "goal" }, plan],
    [session, { ...plan, status: "approved" }, plan],
    [session, plan, undefined],
    [session, plan, { ...plan, id: "p2" }],
  ]) {
    assert.equal(pendingRevisionPlan(target, checkpoint, pending), undefined);
    state.sessions = target ? [target] : [];
    state.planCheckpoints.s1 = checkpoint;
    state.pendingPlans.s1 = pending;
    assert.equal(await send(), false);
  }
  assert.equal(state.resolvePlan.mock.callCount(), 0);
});
