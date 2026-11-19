import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { api } = await import("../src/lib/api.ts");

function harness(mode, proposal) {
  let state = {
    sessions: [{ id: "s", mode }], planningStates: {}, pendingPlans: {},
    planCheckpoints: proposal ? { s: proposal } : {}, runningSessions: {},
    retainedTranscripts: {}, activeSessionId: null, refreshSessions: async () => {},
    refreshQueuedPrompts: async () => {},
  };
  let generation = 0;
  const deps = {
    get: () => state,
    set: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime: {
      nextPlanSyncGeneration: () => ++generation, planSyncGeneration: () => generation,
      liveSessionTranscripts: new Set(), sessionTranscriptCache: new Map(),
    },
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    sessionModeForPlanningState: value => value === "inactive" ? "agent" : "plan",
    openPlanArtifact() {}, notifyInteractivePrompt() {},
  };
  return { get: () => state, sessions: createSessionSlice(deps), events: createEventsSlice(deps) };
}

test("legacy Goal approval changes the visible mode in live events and restoration", async t => {
  const pending = { id: "p", sessionId: "s", kind: "goal", status: "pending", version: 1 };
  const approved = { ...pending, status: "approved", action: "approve", executionState: "queued" };
  const live = harness("goal", pending);
  live.events.handlePlansChanged({ sessionId: "s", state: "inactive", proposal: approved });
  assert.equal(live.get().sessions[0].mode, "agent");
  t.mock.method(api, "pendingPlans", async () => ({ state: "inactive", plans: [] }));
  const restored = harness("goal", pending);
  await restored.sessions.restorePendingPlan("s");
  assert.equal(restored.get().sessions[0].mode, "agent");
});

test("old approved Goal history cannot rename a newly selected staged Goal", async t => {
  t.mock.method(api, "pendingPlans", async () => ({ state: "inactive", plans: [] }));
  const h = harness("goal", { id: "old", kind: "goal", status: "approved" });
  h.events.handlePlansChanged({ sessionId: "s", state: "inactive" });
  assert.equal(h.get().sessions[0].mode, "goal");
  await h.sessions.restorePendingPlan("s");
  assert.equal(h.get().sessions[0].mode, "goal");
});

test("inactive planning without an approved legacy Goal preserves staged and custom modes", async t => {
  t.mock.method(api, "pendingPlans", async () => ({ state: "inactive", plans: [] }));
  for (const mode of ["goal", "review"]) {
    const h = harness(mode);
    h.events.handlePlansChanged({ sessionId: "s", state: "inactive" });
    assert.equal(h.get().sessions[0].mode, mode);
    await h.sessions.restorePendingPlan("s");
    assert.equal(h.get().sessions[0].mode, mode);
  }
});
