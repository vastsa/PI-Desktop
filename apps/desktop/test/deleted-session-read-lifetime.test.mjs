import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createProjectSlice } = await import("../src/stores/slices/project-slice.ts");
const { api } = await import("../src/lib/api.ts");

for (const full of [false, true]) test(`deleted session cannot be cached by its late ${full ? "full" : "bounded"} read`, async t => {
  let state = { activeSessionId: "other", messages: [], sessions: [{ id: "deleted" }], sessionMeta: {}, runningSessions: {}, agentStatuses: {}, sessionOutcomes: {}, queuedPrompts: {}, workPanelContexts: {}, pendingPermissions: {}, pendingAsks: {}, askDrafts: {}, latestTurnResults: {}, planningStates: {}, pendingPlans: {}, planCheckpoints: {}, sessionCompactions: {}, sessionHistory: {}, retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, navStack: [{ page: "chat" }], navIndex: 0, refreshSessions: async () => {}, showToast() {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createProjectSlice({ ...access, runtime, withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)), persistCurrentSidebar() {} });
  let release;
  t.mock.method(api, "getSession", () => new Promise(resolve => { release = resolve; }));
  t.mock.method(api, "deleteSession", async () => ({}));
  t.mock.method(api, "pluginViewClose", async () => ({}));
  const reading = full ? runtime.loadFullSessionMessages("deleted") : runtime.loadSessionDetail("deleted", { messageLimit: 100 });
  await slice.deleteSession("deleted");
  release({ session: { id: "deleted", messages: [{ id: "old", role: "user", content: "old" }] } });
  const result = await reading;
  assert.equal(full ? result : result.session, null, "invalidated reads cannot hand deleted history to callers");
  assert.equal(runtime.sessionTranscriptCache.has("deleted"), false);
  assert.equal(runtime.sessionHistoryCache.has("deleted"), false);
  assert.equal(state.sessions.some(session => session.id === "deleted"), false);
});

test("invalidating a selected session prevents its pending navigation from committing", () => {
  const runtime = createSessionRuntime({ get: () => ({}), set() {} });
  const intent = runtime.beginNavigationIntent();
  runtime.beginSessionSelection("deleted", intent);
  runtime.invalidateSessionReads("deleted");
  assert.equal(runtime.navigationIntentIsCurrent(intent), false);
  assert.equal(runtime.isSessionSelectionPending("deleted"), false);
});

test("old read cleanup cannot invalidate a fresh read after deletion", async t => {
  const runtime = createSessionRuntime({ get: () => ({ retainedTranscripts: {}, runningSessions: {} }), set() {} });
  const releases = [];
  t.mock.method(api, "getSession", () => new Promise(resolve => releases.push(resolve)));
  const old = runtime.loadSessionDetail("session");
  runtime.invalidateSessionReads("session");
  const fresh = runtime.loadSessionDetail("session");
  releases[0]({ session: { id: "session", messages: [{ id: "old", role: "user", content: "old" }] } });
  assert.equal((await old).session, null);
  const current = [{ id: "new", role: "user", content: "new" }];
  releases[1]({ session: { id: "session", messages: current } });
  await fresh;
  assert.deepEqual(runtime.sessionTranscriptCache.get("session"), current);
});
