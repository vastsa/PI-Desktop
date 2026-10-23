import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");

const sessionId = "stop-fixture";
const message = (id, role, extra = {}) => ({
  id, role, content: role === "assistant" ? "partial answer" : "inspect", createdAt: "2026-09-30T00:00:00Z", ...extra,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(source = "desktop", rows = [
  message("user-1", "user"),
  message("assistant-1", "assistant", { status: "streaming" }),
  message("grep-1", "tool", { toolName: "Grep", toolStatus: "running" }),
]) {
  let runtime;
  let state = {
    activeSessionId: sessionId, sessions: [{ id: sessionId, source, capabilities: { canStop: true } }],
    messages: rows, retainedSessionIds: [sessionId], retainedTranscripts: { [sessionId]: rows },
    sessionHistory: {}, runningSessions: { [sessionId]: true }, isRunning: true,
    agentStatuses: { [sessionId]: { isRunning: true, currentTurnId: "turn-1", activity: { phase: "waiting-model", since: 1 } } },
    pendingPermissions: {}, pendingAsks: {}, latestTurnResults: {}, sessionOutcomes: {},
  };
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript(sessionId, rows);
  const slice = createTranscriptSlice({
    ...access, runtime, promptAttachmentsFromMessage: () => [], viewingSessionIdForPrompt: () => null,
    flushPendingSessionConfiguration: async () => {},
  });
  return { ...access, runtime, slice };
}

for (const source of ["pi-native", "remote"]) {
  test(`${source} Stop publishes settled state before a slow secondary history read`, async (t) => {
    const h = harness(source);
    const abort = deferred();
    const detail = deferred();
    const reading = deferred();
    t.mock.method(api, "abort", () => abort.promise);
    t.mock.method(api, "getSession", () => { reading.resolve(); return detail.promise; });
    const stopping = h.slice.abort();
    assert.equal(h.get().isRunning, true, "never fake idle before backend settlement");
    abort.resolve({ ok: true });
    await reading.promise;
    const settled = {
      isRunning: h.get().isRunning, running: h.get().runningSessions[sessionId],
      statusRunning: h.get().agentStatuses[sessionId]?.isRunning ?? false,
      assistant: h.get().messages[1].status, tool: h.get().messages[2].toolStatus,
    };
    detail.resolve({ session: { messages: h.get().messages } });
    await stopping;
    assert.deepEqual(settled, { isRunning: false, running: false, statusRunning: false, assistant: "aborted", tool: "error" });
  });
}

test("smart Stop history failure cannot retain the running badge or unresolved draft", async (t) => {
  const h = harness("desktop", [message("user-1", "user")]);
  const draft = { messageCountBeforeSend: 0, draft: { text: "inspect", fileReferences: [{ path: "src/a.ts", name: "a.ts" }] } };
  h.runtime.submittedComposerDrafts.set(sessionId, draft);
  t.mock.method(api, "abort", async () => ({ ok: true }));
  const historyFailure = new Error("history unavailable");
  t.mock.method(api, "getSession", async () => { throw historyFailure; });
  await assert.rejects(h.slice.abort(), historyFailure);
  assert.equal(h.get().isRunning, false);
  assert.equal(h.get().runningSessions[sessionId], false);
  assert.equal(h.get().agentStatuses[sessionId]?.isRunning ?? false, false);
  assert.equal(await draft.abortResolution, false);
  assert.equal(h.runtime.submittedComposerDrafts.has(sessionId), false);
});

test("failed backend abort remains observable and never pretends tool settlement", async (t) => {
  const h = harness();
  const failure = Object.assign(new Error("abort transport failed"), { code: "RPC_TIMEOUT" });
  t.mock.method(api, "abort", async () => { throw failure; });
  await assert.rejects(h.slice.abort(), failure);
  assert.equal(h.get().isRunning, true);
  assert.equal(h.get().runningSessions[sessionId], true);
  assert.equal(h.get().messages[2].toolStatus, "running");
});

test("Stop settles its retained session after switching without clearing the visible session", async (t) => {
  const h = harness();
  const abort = deferred();
  t.mock.method(api, "abort", () => abort.promise);
  const stopping = h.slice.abort();
  const other = [message("other-live", "assistant", { status: "streaming" })];
  h.set({ activeSessionId: "other", messages: other, isRunning: true, runningSessions: { [sessionId]: true, other: true } });
  abort.resolve({ ok: true });
  await stopping;
  assert.equal(h.get().isRunning, true);
  assert.equal(h.get().messages, other);
  assert.equal(h.get().runningSessions.other, true);
  assert.equal(h.get().runningSessions[sessionId], false);
  assert.equal(h.get().retainedTranscripts[sessionId][1].status, "aborted");
  assert.equal(h.runtime.sessionTranscriptCache.get(sessionId)[2].toolStatus, "error");
});

test("a late smart Stop history read cannot clobber a switched session", async (t) => {
  const h = harness("desktop", [message("user-1", "user")]);
  const detail = deferred();
  const reading = deferred();
  h.runtime.submittedComposerDrafts.set(sessionId, { messageCountBeforeSend: 0, draft: { text: "inspect", fileReferences: [] } });
  t.mock.method(api, "abort", async () => ({ ok: true }));
  t.mock.method(api, "getSession", () => { reading.resolve(); return detail.promise; });
  const stopping = h.slice.abort();
  await reading.promise;
  const other = [message("other", "assistant", { status: "streaming" })];
  h.set({ activeSessionId: "other", messages: other, isRunning: true, runningSessions: { [sessionId]: false, other: true } });
  detail.resolve({ session: { messages: [message("user-1", "user"), message("assistant-1", "assistant", { status: "complete" })] } });
  await stopping;
  assert.equal(h.get().isRunning, true);
  assert.equal(h.get().messages, other);
  assert.equal(h.get().composerPrefill, undefined);
});

test("a new turn in the same session survives an older Stop acknowledgement", async (t) => {
  const h = harness();
  const abort = deferred();
  t.mock.method(api, "abort", () => abort.promise);
  const stopping = h.slice.abort();
  const nextDraft = { messageCountBeforeSend: 3, draft: { text: "follow up", fileReferences: [] } };
  h.runtime.submittedComposerDrafts.set(sessionId, nextDraft);
  const nextRows = [...h.get().messages, message("user-2", "user"), message("assistant-2", "assistant", { status: "streaming" })];
  h.set({ messages: nextRows, agentStatuses: { [sessionId]: { isRunning: true, currentTurnId: "turn-2" } } });
  abort.resolve({ ok: true });
  await stopping;
  assert.equal(h.get().isRunning, true);
  assert.equal(h.get().runningSessions[sessionId], true);
  assert.equal(h.get().messages.at(-1).status, "streaming");
  assert.equal(h.runtime.submittedComposerDrafts.get(sessionId), nextDraft);
});

test("unanswered smart Stop restores structured references only after backend settlement", async (t) => {
  const previous = message("previous", "assistant", { status: "complete" });
  const h = harness("desktop", [previous, message("user-1", "user")]);
  const draft = { text: "inspect", fileReferences: [{ path: "src/a.ts", name: "a.ts" }] };
  h.runtime.submittedComposerDrafts.set(sessionId, { messageCountBeforeSend: 1, draft });
  const abort = deferred();
  t.mock.method(api, "abort", () => abort.promise);
  t.mock.method(api, "getSession", async () => ({ session: { messages: h.get().messages } }));
  t.mock.method(api, "replaceSessionMessages", async () => ({}));
  const stopping = h.slice.abort();
  assert.equal(h.get().isRunning, true);
  assert.equal(h.get().composerPrefill, undefined);
  abort.resolve({ ok: true });
  await stopping;
  assert.deepEqual(h.get().messages, [previous]);
  assert.deepEqual(h.get().composerPrefill, { ...draft, sessionId });
  assert.equal(h.get().isRunning, false);
});

test("repeated Stop shares one pending backend settlement", async (t) => {
  const h = harness();
  const abort = deferred();
  const calls = [];
  t.mock.method(api, "abort", (id) => { calls.push(id); return abort.promise; });
  const first = h.slice.abort();
  const second = h.slice.abort();
  assert.equal(h.get().isRunning, true);
  abort.resolve({ ok: true });
  await Promise.all([first, second]);
  assert.deepEqual(calls, [sessionId]);
  assert.equal(h.get().isRunning, false);
});

test("Stop admission can acquire its initial turn status while the abort is pending", async (t) => {
  const h = harness("desktop", [message("user-1", "user")]);
  h.set({ agentStatuses: {} });
  h.runtime.submittedComposerDrafts.set(sessionId, { messageCountBeforeSend: 0, draft: { text: "inspect", fileReferences: [] } });
  const abort = deferred();
  t.mock.method(api, "abort", () => abort.promise);
  t.mock.method(api, "getSession", async () => ({ session: { messages: h.get().messages } }));
  t.mock.method(api, "replaceSessionMessages", async () => ({}));
  const stopping = h.slice.abort();
  h.set({ agentStatuses: { [sessionId]: { isRunning: true, currentTurnId: "turn-1" } } });
  abort.resolve({ ok: true });
  await stopping;
  assert.equal(h.get().isRunning, false);
  assert.equal(h.get().runningSessions[sessionId], false);
});

test("late native history cannot replace a newer same-session transcript", async (t) => {
  const h = harness("pi-native");
  const detail = deferred();
  const reading = deferred();
  t.mock.method(api, "abort", async () => ({ ok: true }));
  t.mock.method(api, "getSession", () => { reading.resolve(); return detail.promise; });
  const stopping = h.slice.abort();
  await reading.promise;
  const next = [message("user-2", "user"), message("assistant-2", "assistant", { status: "streaming" })];
  h.set({ messages: next, isRunning: true, runningSessions: { [sessionId]: true }, agentStatuses: { [sessionId]: { isRunning: true, currentTurnId: "turn-2" } } });
  detail.resolve({ session: { messages: [message("old", "assistant", { status: "complete" })] } });
  await stopping;
  assert.equal(h.get().messages, next);
  assert.equal(h.runtime.sessionTranscriptCache.get(sessionId), next);
  assert.equal(h.get().isRunning, true);
});

test("Stop admission ignores prior history when acquiring the submitted turn", async (t) => {
  const h = harness("desktop", [
    message("old-answer", "assistant", { status: "complete" }),
    message("user-1", "user"),
  ]);
  h.set({ agentStatuses: {} });
  h.runtime.submittedComposerDrafts.set(sessionId, { messageCountBeforeSend: 1, draft: { text: "inspect", fileReferences: [] } });
  const abort = deferred();
  t.mock.method(api, "abort", () => abort.promise);
  t.mock.method(api, "getSession", async () => ({ session: { messages: h.get().messages } }));
  t.mock.method(api, "replaceSessionMessages", async () => ({}));
  const stopping = h.slice.abort();
  h.set({ agentStatuses: { [sessionId]: { isRunning: true, currentTurnId: "turn-1" } } });
  abort.resolve({ ok: true });
  await stopping;
  assert.equal(h.get().isRunning, false);
  assert.equal(h.get().runningSessions[sessionId], false);
});

test("late native history cannot replace a newer turn that already completed", async (t) => {
  const h = harness("pi-native");
  const detail = deferred();
  const reading = deferred();
  t.mock.method(api, "abort", async () => ({ ok: true }));
  t.mock.method(api, "getSession", () => { reading.resolve(); return detail.promise; });
  const stopping = h.slice.abort();
  await reading.promise;
  const next = [message("user-2", "user"), message("answer-2", "assistant", { status: "complete" })];
  h.set({ messages: next, isRunning: false, runningSessions: { [sessionId]: false }, agentStatuses: {} });
  detail.resolve({ session: { messages: [message("old", "assistant", { status: "complete" })] } });
  await stopping;
  assert.equal(h.get().messages, next);
  assert.equal(h.runtime.sessionTranscriptCache.get(sessionId), next);
});
