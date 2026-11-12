import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");
const { withoutRecordKey } = await import("../src/stores/helpers/store-helpers.ts");

function buildStore() {
  let state = {
    activeSessionId: "session",
    sessions: [{ id: "session", mode: "agent" }],
    runningSessions: {},
    pendingPlans: {},
    sessionMeta: {},
    planningStates: {},
    retainedTranscripts: {},
    retainedSessionIds: [],
    sessionHistory: {},
    navStack: [],
    navIndex: -1,
    settings: {},
    providers: [],
    recentModels: [],
    messages: [],
    acknowledgeSessionOutcome: () => Promise.resolve(),
    restorePendingPlan: () => {},
    restorePendingInteractive: () => {},
    showToast: () => {},
  };
  const access = {
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
  };
  const runtime = createSessionRuntime(access);
  const coordination = createSessionCoordination({ ...access, runtime, withoutRecordKey });
  const slice = createSessionSlice({ ...access, runtime, ...coordination });
  return { stateRef: () => state, runtime, slice };
}

test("a warm re-select does not commit a detail window a concurrent idle edit superseded", async t => {
  const stored = { id: "answer", role: "assistant", content: "before edit" };
  const edited = [{ ...stored, content: "after edit" }];
  const { stateRef, runtime, slice } = buildStore();
  runtime.cacheSessionTranscript("session", [stored], { messageStart: 0, hasMoreBefore: false });
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));
  const selecting = slice.selectSession("session");
  await new Promise(resolve => setImmediate(resolve));
  // The idle edit writers (deleteMessage / activateMessageRevision) replace
  // the cache entry and the visible transcript while the read is in flight.
  runtime.cacheSessionTranscript("session", edited, { messageStart: 0, hasMoreBefore: false });
  stateRef().messages = edited;
  finish({ session: { id: "session", messages: [stored], messageStart: 0, hasMoreBefore: false } });
  await selecting;
  assert.equal(runtime.sessionTranscriptCache.get("session"), edited, "the newer edit cache survives");
  assert.equal(stateRef().messages, edited, "the visible transcript keeps the edit");
  assert.deepEqual(stateRef().sessionHistory.session, { messageStart: 0, hasMoreBefore: false },
    "the window stays the edit writer's, not the stale read's");
  assert.equal(stateRef().selectingSessionId, undefined, "the selection still completes");
});

test("an uneventful warm re-select still hydrates the read window", async t => {
  const saved = { id: "answer", role: "assistant", content: "saved answer" };
  const { stateRef, runtime, slice } = buildStore();
  t.mock.method(api, "getSession", async () => ({
    session: { id: "session", messages: [saved], messageStart: 5, hasMoreBefore: true },
  }));
  await slice.selectSession("session");
  assert.deepEqual(stateRef().messages, [saved]);
  assert.deepEqual(runtime.sessionTranscriptCache.get("session"), [saved]);
  assert.deepEqual(stateRef().sessionHistory.session,
    { messageStart: 5, hasMoreBefore: true, contentLimited: true });
  assert.equal(stateRef().selectingSessionId, undefined);
});

test("a running session still merges its live tail over the detail window", async t => {
  const saved = { id: "prompt", role: "user", content: "question" };
  const streamed = { id: "live", role: "assistant", content: "partial", status: "streaming" };
  const { stateRef, runtime, slice } = buildStore();
  stateRef().runningSessions.session = true;
  runtime.cacheSessionTranscript("session", [saved, streamed], { messageStart: 0, hasMoreBefore: false });
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));
  const selecting = slice.selectSession("session");
  await new Promise(resolve => setImmediate(resolve));
  const tailed = [saved, streamed, { id: "tail", role: "assistant", content: "more" }];
  // Streaming events land in the store projection first; the cache boundary
  // mirrors them (syncTranscriptProjection).
  stateRef().messages = tailed;
  runtime.cacheSessionTranscript("session", tailed, { messageStart: 0, hasMoreBefore: false });
  finish({ session: { id: "session", messages: [saved] } });
  await selecting;
  assert.equal(runtime.sessionTranscriptCache.get("session").length, 3, "the live tail survives for running sessions");
  assert.equal(stateRef().messages.length, 3);
});

test("a cold first read also keeps an idle edit that lands during the read", async t => {
  // No cache entry exists when the read starts, so the pre-read capture is
  // undefined. An edit that lands in the window moves the cache from
  // undefined to the edit writer's entry — the same movement the #2233
  // runtime guard catches with a plain `!== previous`; the caller guard must
  // not require a defined capture to see it.
  const stored = { id: "answer", role: "assistant", content: "before edit" };
  const edited = [{ ...stored, content: "after edit" }];
  const { stateRef, runtime, slice } = buildStore();
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));
  const selecting = slice.selectSession("session");
  await new Promise(resolve => setImmediate(resolve));
  runtime.cacheSessionTranscript("session", edited, { messageStart: 0, hasMoreBefore: false });
  stateRef().messages = edited;
  finish({ session: { id: "session", messages: [stored], messageStart: 0, hasMoreBefore: false } });
  await selecting;
  assert.equal(runtime.sessionTranscriptCache.get("session"), edited, "the edit cache survives the cold read");
  assert.equal(stateRef().messages, edited, "the visible transcript keeps the edit");
  assert.equal(stateRef().selectingSessionId, undefined, "the selection still completes");
});

test("a cold first read without edits still hydrates the detail window", async t => {
  // The runtime caches this read's own detail (nothing moved before it), so
  // the guard trips on that self-write and falls back to the cache entry —
  // the same content the plain path would have committed.
  const saved = { id: "answer", role: "assistant", content: "saved answer" };
  const { stateRef, runtime, slice } = buildStore();
  t.mock.method(api, "getSession", async () => ({
    session: { id: "session", messages: [saved], messageStart: 5, hasMoreBefore: true },
  }));
  await slice.selectSession("session");
  assert.deepEqual(stateRef().messages, [saved]);
  assert.deepEqual(runtime.sessionTranscriptCache.get("session"), [saved]);
  assert.deepEqual(stateRef().sessionHistory.session,
    { messageStart: 5, hasMoreBefore: true, contentLimited: true });
});
