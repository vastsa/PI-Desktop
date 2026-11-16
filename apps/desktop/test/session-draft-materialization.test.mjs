import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createQueueSlice } = await import("../src/stores/slices/queue-slice.ts");

function fixture(t) {
  const gate = Promise.withResolvers();
  let created = 0;
  let state = {
    activeSessionId: undefined, page: "chat", sessions: [], messages: [],
    sessionMeta: {}, pendingPlans: {}, planCheckpoints: {}, planningStates: {},
    runningSessions: {}, agentStatuses: {}, latestTurnResults: {}, sessionOutcomes: {},
    sessionCompactions: {}, sessionHistory: {}, retainedSessionIds: [], retainedTranscripts: {},
    workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null,
    workPanelOpen: false, workPanelFileRequest: null, navStack: [], navIndex: -1,
    settings: {}, providers: [], providerModels: {}, recentModels: [], draftConfiguration: null,
    workspace: { path: "/synthetic/project" }, activeProjectPath: "/synthetic/project",
    defaultProjectPath: "/synthetic/project", queuedPrompts: {},
    refreshSessions: async () => {}, rememberModel: () => {}, showToast: () => {},
  };
  const get = () => state;
  const set = update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
  const runtime = createSessionRuntime({ get, set });
  const withoutRecordKey = (record, key) => { const result = { ...record }; delete result[key]; return result; };
  t.mock.method(api, "createSession", async () => {
    const id = `created-${++created}`;
    await gate.promise;
    return { session: { id, title: "New task", mode: "agent", messageCount: 0,
      projectPath: "/synthetic/project", updatedAt: "2026-11-02T00:00:00Z" } };
  });
  t.mock.method(api, "prompt", async () => ({}));
  t.mock.method(api, "deriveSessionTitle", async () => ({ updated: false }));
  const coordination = createSessionCoordination({
    get, set, runtime, decorateSessions: rows => rows, withoutRecordKey,
    untitledTaskTitle: () => "New task",
  });
  Object.assign(state, createSessionSlice({
    get, set, runtime, decorateSessions: rows => rows, withoutRecordKey,
    ...coordination, getBootstrapGeneration: () => 0,
  }));
  Object.assign(state, createQueueSlice({
    get, set, runtime, materializeDraftSession: coordination.materializeDraftSession,
    flushPendingSessionConfiguration: coordination.flushPendingSessionConfiguration,
    recordSubmittedInput: async () => {}, insertOptimisticUserMessage: runtime.insertOptimisticUserMessage,
    retractOptimisticUserMessage: runtime.retractOptimisticUserMessage,
    promptAttachmentsFromDraft: () => [], withoutRecordKey,
    sessionTranscriptCache: runtime.sessionTranscriptCache,
    submittedComposerDrafts: runtime.submittedComposerDrafts,
    viewingSessionIdForPrompt: () => null,
    messageErrorFromUnknown: error => ({ code: "FAILED", message: error.message }),
    assistantErrorMessage: error => ({ id: "error", role: "assistant", content: "", error }),
  }));
  return { get, set, runtime, coordination, gate, created: () => created };
}

test("first prompt during New Task creation uses the same durable row", async t => {
  const f = fixture(t);
  const creation = f.get().newSession({ projectPath: "/synthetic/project" });
  const sending = f.get().sendPrompt("Synthetic first prompt");
  f.gate.resolve();
  await creation;
  assert.equal(await sending, true);
  assert.equal(f.created(), 1, "sending must not invalidate and replace the pending New Task");
  assert.deepEqual(f.get().sessions.map(session => session.id), ["created-1"]);
  assert.equal(f.get().activeSessionId, "created-1");
  assert.equal(f.runtime.pendingNewSessionRequests.size, 0);
});

test("overlapping first inputs share one creation result", async t => {
  const f = fixture(t);
  const first = f.coordination.materializeDraftSession();
  const second = f.coordination.materializeDraftSession();
  f.gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["created-1", "created-1"]);
  assert.equal(f.created(), 1);
  assert.equal(f.get().sessions.length, 1);
  assert.equal(f.runtime.pendingNewSessionRequests.size, 0);
});

test("superseded creation never targets a different selected session", async t => {
  const f = fixture(t);
  const creation = f.get().newSession({ projectPath: "/synthetic/project" });
  const input = f.coordination.materializeDraftSession();
  f.runtime.beginNavigationIntent();
  f.set({ activeSessionId: "unrelated-session" });
  f.gate.resolve();
  await creation;
  assert.equal(await input, null);
  assert.equal(f.created(), 1);
  assert.equal(f.get().activeSessionId, "unrelated-session");
});

test("failed creation rejects all waiters and releases the slot for retry", async t => {
  const f = fixture(t);
  const first = f.coordination.materializeDraftSession();
  const second = f.coordination.materializeDraftSession();
  const settled = Promise.allSettled([first, second]);
  f.gate.reject(new Error("synthetic creation failure"));
  const results = await settled;
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(f.runtime.pendingNewSessionRequests.size, 0);
  t.mock.method(api, "createSession", async () => ({ session: {
    id: "retry", title: "New task", mode: "agent", messageCount: 0,
    projectPath: "/synthetic/project", updatedAt: "2026-11-02T00:00:00Z",
  } }));
  assert.equal(await f.coordination.materializeDraftSession(), "retry");
});

test("sending a Goal returns only its input mode to Agent and keeps newer model settings", async t => {
  const f = fixture(t);
  f.set({ activeSessionId: "goal", sessions: [{ id: "goal", title: "Task", mode: "goal", permissionMode: "auto", providerId: "p", modelId: "old", thinkingLevel: "high" }] });
  const accepted = Promise.withResolvers();
  const requests = [];
  t.mock.method(api, "prompt", async request => { requests.push(request); await accepted.promise; return { accepted: true }; });
  const sending = f.get().sendPrompt("first objective");
  await f.get().configureActiveSession({ mode: "goal", modelId: "new", thinkingLevel: "high", permissionMode: "auto" });
  accepted.resolve();
  assert.equal(await sending, true);
  assert.equal(requests[0].startGoal, true);
  assert.equal(f.get().sessions[0].mode, "agent");
  assert.equal(f.get().sessions[0].modelId, "new");
  assert.equal(f.get().runningSessions.goal, true);
  assert.equal(f.runtime.pendingSessionConfigurations.get("goal").permissionMode, "auto");
});

test("a queued second Goal is explicit and resets the input, while rejected and newer selections remain", async t => {
  const f = fixture(t);
  f.set({ activeSessionId: "goal", sessions: [{ id: "goal", title: "Task", mode: "goal", thinkingLevel: "high" }], runningSessions: { goal: true } });
  const requests = [];
  t.mock.method(api, "queuePrompt", async request => { requests.push(request); return { id: "queued", ...request }; });
  t.mock.method(api, "listQueuedPrompts", async () => ({ entries: [] }));
  assert.equal(await f.get().sendPrompt("replacement"), true);
  assert.equal(requests[0].startGoal, true);
  assert.equal(f.get().sessions[0].mode, "agent");
  await f.get().configureActiveSession({ mode: "goal", thinkingLevel: "high" });
  const gate = Promise.withResolvers();
  t.mock.method(api, "queuePrompt", async () => gate.promise);
  const sending = f.get().sendPrompt("later goal");
  await f.get().configureActiveSession({ mode: "plan", thinkingLevel: "high" });
  gate.resolve({ id: "later", content: "later goal", sessionId: "goal" });
  assert.equal(await sending, true);
  assert.equal(f.get().sessions[0].mode, "plan");
  await f.get().configureActiveSession({ mode: "goal", thinkingLevel: "high" });
  t.mock.method(api, "queuePrompt", async () => { throw new Error("queue full"); });
  assert.equal(await f.get().sendPrompt("rejected"), false);
  assert.equal(f.get().sessions[0].mode, "goal");
});
