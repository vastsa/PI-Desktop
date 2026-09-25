import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { api } = await import("../src/lib/api.ts");

function harness(t) {
  const old = { id: "old", role: "assistant", content: "first reply", status: "complete" };
  const live = { id: "live", role: "assistant", content: "second reply", status: "streaming" };
  let state = {
    activeSessionId: "parent", isRunning: true, runningSessions: { parent: true },
    messages: [old, live], sessions: [{ id: "parent", title: "Source", mode: "agent" }],
    sessionHistory: { parent: { hasMoreBefore: true, contentLimited: true } },
    sessionMeta: {}, sessionCompactions: {}, planningStates: {},
    retainedSessionIds: ["parent"], retainedTranscripts: { parent: [old, live] },
    workPanelContexts: {}, workPanelTabs: [], workPanelOpen: false,
    navStack: [{ page: "chat", sessionId: "parent" }], navIndex: 0,
    restorePendingPlan: async () => {},
  };
  let intent = 0;
  const cache = new Map([["parent", state.messages]]);
  const runtime = {
    beginNavigationIntent: () => ++intent,
    navigationIntentIsCurrent: (value) => value === intent,
    cacheSessionTranscript: (id, messages) => cache.set(id, messages),
    loadFullSessionMessages: () => assert.fail("fork must not hydrate over a live transcript"),
  };
  const access = {
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime,
    decorateSessions: (sessions) => sessions,
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
  };
  const coordination = createSessionCoordination(access);
  const slice = createSessionSlice({ ...access, ...coordination });
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  t.mock.method(api, "forkSession", (id, _title, anchor) => {
    assert.equal(id, "parent"); assert.equal(anchor, "old");
    return pending;
  });
  return {
    slice, runtime, cache, get: access.get, set: access.set,
    complete: () => resolve({ session: { id: "child", title: "Branch", mode: "agent", messages: [{ ...old, id: "child-old" }] } }),
    reject,
  };
}

test("reply fork activates an independent child without hydrating or stopping its streaming parent", async (t) => {
  const h = harness(t);
  const parent = h.get().messages;
  const action = h.slice.forkAssistantMessage("old");
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "child");
  assert.equal(h.get().isRunning, false);
  assert.equal(h.get().runningSessions.parent, true);
  assert.equal(h.cache.get("parent"), parent);
  assert.equal(h.get().retainedTranscripts.parent[1].status, "streaming");
  assert.deepEqual(h.get().messages.map(m => m.id), ["child-old"]);
  assert.deepEqual(h.get().sessions.map(s => s.id), ["child", "parent"]);
});

test("a fork that finishes after navigation lists the child without stealing the view", async (t) => {
  const h = harness(t);
  const action = h.slice.forkAssistantMessage("old");
  h.runtime.beginNavigationIntent();
  h.set({ activeSessionId: "other", messages: [], isRunning: false });
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "other");
  assert.deepEqual(h.get().messages, []);
  assert.equal(h.get().runningSessions.parent, true);
  assert.deepEqual(h.get().sessions.map(s => s.id), ["child", "parent"]);
});

test("a rejected fork reports the error and keeps the original turn and transcript", async (t) => {
  const h = harness(t);
  const parent = h.get().messages;
  const action = h.slice.forkAssistantMessage("old");
  h.reject(Object.assign(new Error("Cannot fork this active turn"), { code: "AGENT_BUSY" }));
  await action;
  assert.equal(h.get().errorCode, "AGENT_BUSY");
  assert.equal(h.get().activeSessionId, "parent");
  assert.equal(h.get().messages, parent);
  assert.equal(h.get().isRunning, true);
});
