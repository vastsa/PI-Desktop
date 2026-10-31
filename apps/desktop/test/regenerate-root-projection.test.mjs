import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { api } = await import("../src/lib/api.ts");

const sessionId = "regenerated-session";
const turnId = "latest-turn";
const root = {
  id: "rewritten-user", role: "user", content: "An older regenerated prompt",
  createdAt: "2026-10-20T06:14:11.000Z", status: "complete",
  revisionRootId: "original-user", revisionCount: 2, activeRevision: 2,
};
const tail = [
  { id: "latest-user", role: "user", content: "Continue", createdAt: "2026-10-25T15:00:00.000Z", status: "complete" },
  { id: "latest-answer", role: "assistant", content: "Latest reply", createdAt: "2026-10-25T15:04:05.000Z", status: "complete" },
];

// Drive the actual main persistence and renderer event/cache wiring. The host
// RPC is the external boundary; all transcript projection code remains real.
function fixture({ active, includeRoot, evictCache = false, hostCall }) {
  const messages = includeRoot ? [{ ...root, revisionCount: 1, activeRevision: 1 }, ...tail] : tail;
  const otherMessages = [{ ...tail[0], id: "other-user" }];
  let state = {
    activeSessionId: active ? sessionId : "other-session",
    messages: active ? messages : otherMessages,
    retainedSessionIds: [sessionId], retainedTranscripts: { [sessionId]: messages },
    runningSessions: {}, sessionHistory: {},
  };
  let runtime;
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript(sessionId, messages);
  if (evictCache) runtime.sessionTranscriptCache.delete(sessionId);
  Object.assign(state, createEventsSlice({ ...access, runtime }));

  const activeTurns = new Map([[sessionId, turnId]]);
  const coordination = createSessionCoordination({
    activeTurns, getMainWindow: () => null, getViewingSessionId: () => null,
  });
  coordination.recordTurnStart(sessionId, turnId);
  const emitted = [];
  const calls = [];
  const warnings = [];
  const persistence = createEventPersistence({
    runtimeState: { host: { async call(method, params) {
      calls.push({ method, params });
      assert.equal(method, "session.saveActiveRevision");
      return hostCall ? hostCall() : { saved: { root, archived: false } };
    } } },
    steeringReplies: new Set(), completionNoticeTurns: new Set(), activeTurns,
    activeToolCalls: new Map(), activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: { observe() {}, flush: async () => {}, settleIf() {} },
    persistenceOutbox: { size: () => 0, flush: async () => {} },
    transcriptRewrite: coordination, addActiveTurnUsage() {},
    logger: { app: (...args) => warnings.push(args) },
    finishTurn: async () => { activeTurns.delete(sessionId); },
    isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    finishApprovedExecution: async () => {},
    emitAgentEvent: (envelope) => {
      emitted.push(envelope);
      state.handleAgentEvent(envelope);
    },
  });
  return { ...access, runtime, emitted, calls, warnings, persistence, messages, otherMessages };
}

async function completeTurn(f) {
  f.persistence.persistAgentEvent({ sessionId, turnId, ts: 1,
    event: { type: "agent_end", messageIds: [tail.at(-1).id] } });
  await f.persistence.flush();
}

for (const active of [true, false]) {
  for (const includeRoot of [false, true]) {
    test(`branch archive ${includeRoot ? "updates the loaded pager" : "keeps an unloaded root out of the tail"} in ${active ? "the active session" : "a background session"}`, async () => {
      const f = fixture({ active, includeRoot });
      await completeTurn(f);
      assert.deepEqual(f.warnings, []);
      assert.equal(f.calls.length, 1);
      for (const rows of [
        f.runtime.sessionTranscriptCache.get(sessionId),
        f.get().retainedTranscripts[sessionId],
        ...(active ? [f.get().messages] : []),
      ]) {
        assert.deepEqual(rows.map((row) => row.id), f.messages.map((row) => row.id));
        assert.equal(rows.at(-1).id, "latest-answer");
        if (includeRoot) assert.deepEqual(rows[0], root);
      }
      if (!active) assert.equal(f.get().messages, f.otherMessages);
    });
  }

  test(`an evicted cache keeps the retained ${active ? "active" : "background"} window without resurrecting its absent root`, async () => {
    const f = fixture({ active, includeRoot: false, evictCache: true });
    await completeTurn(f);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.runtime.sessionTranscriptCache.get(sessionId), tail);
    assert.deepEqual(f.get().retainedTranscripts[sessionId], tail);
  });
}

test("an archive acknowledgement does not resurrect a root deleted while the RPC was pending", async () => {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const f = fixture({ active: true, includeRoot: true, hostCall: () => {
    started.resolve();
    return response.promise;
  } });
  const completion = completeTurn(f);
  await started.promise;
  f.set({ messages: tail });
  response.resolve({ saved: { root } });
  await completion;
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.get().messages, tail);
  assert.deepEqual(f.runtime.sessionTranscriptCache.get(sessionId), tail);
  assert.deepEqual(f.get().retainedTranscripts[sessionId], tail);
});

test("an ordinary user message_end still appends a newly delivered prompt", () => {
  const f = fixture({ active: true, includeRoot: false });
  const message = { ...root, id: "new-user", createdAt: "2026-10-25T15:05:00.000Z" };
  f.get().handleAgentEvent({ sessionId, ts: 2, event: { type: "message_end", message } });
  assert.deepEqual(f.get().messages, [...tail, message]);
});

test("an archive acknowledgement leaves an unloaded background session available to prefetch", async () => {
  const f = fixture({ active: false, includeRoot: false, evictCache: true });
  f.set({ retainedTranscripts: {} });
  const originalGetSession = api.getSession;
  const reads = [];
  api.getSession = async (id) => {
    reads.push(id);
    return { session: { id, messages: tail, messageCount: tail.length } };
  };
  try {
    await completeTurn(f);
    assert.deepEqual(f.warnings, []);
    assert.equal(f.runtime.sessionTranscriptCache.has(sessionId), false);
    assert.equal(f.runtime.liveSessionTranscripts.has(sessionId), false);
    assert.deepEqual(f.get().retainedTranscripts, {});
    assert.equal(f.get().messages, f.otherMessages);

    const sessions = createSessionSlice({ get: f.get, set: f.set, runtime: f.runtime });
    await sessions.prefetchSession(sessionId);
    assert.deepEqual(reads, [sessionId]);
    assert.deepEqual(f.runtime.sessionTranscriptCache.get(sessionId), tail);
  } finally {
    api.getSession = originalGetSession;
  }
});
