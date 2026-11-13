import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

// Based on the reproduction in #2234 by yg2224.

function fixture(overrides = {}) {
  let state = {
    activeSessionId: "session",
    sessions: [{ id: "session", source: "desktop" }],
    messages: [],
    isRunning: true,
    runningSessions: { session: true },
    retainedTranscripts: {},
    pendingPermissions: {},
    sessionHistory: {},
    ...overrides,
  };
  const access = {
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
  };
  const runtime = createSessionRuntime(access);
  const slice = createTranscriptSlice({ ...access, runtime, flushPendingSessionConfiguration: async () => {} });
  return { runtime, slice, state: () => state };
}

test("a failed Stop keeps the turn running and its submitted draft for retry", async t => {
  const rows = [
    { id: "prompt", role: "user", content: "work" },
    { id: "answer", role: "assistant", content: "partial", status: "streaming" },
  ];
  const f = fixture({ messages: rows });
  const submitted = { messageCountBeforeSend: 0, draft: { text: "work", fileReferences: [] } };
  f.runtime.submittedComposerDrafts.set("session", submitted);
  t.mock.method(api, "abort", async () => { throw new Error("host disconnected"); });
  await assert.rejects(f.slice.abort(), /host disconnected/);
  assert.equal(f.state().isRunning, true);
  assert.equal(f.state().runningSessions.session, true);
  assert.equal(f.state().messages, rows);
  assert.equal(f.runtime.submittedComposerDrafts.get("session"), submitted);
  assert.equal(submitted.abortResolution, undefined, "a failed stop must not leave a pending abort waiter");

  t.mock.method(api, "abort", async () => ({ ok: true }));
  await f.slice.abort();
  assert.equal(f.state().isRunning, false);
  assert.equal(f.state().runningSessions.session, false);
  assert.equal(f.state().messages[1].status, "aborted");
  assert.equal(f.runtime.submittedComposerDrafts.has("session"), false);
});

test("a failed Stop releases a submission already waiting on its abort", async t => {
  const f = fixture();
  const submitted = { messageCountBeforeSend: 0, draft: { text: "work", fileReferences: [] } };
  f.runtime.submittedComposerDrafts.set("session", submitted);
  let reject;
  t.mock.method(api, "abort", () => new Promise((_, fail) => { reject = fail; }));
  const stopping = f.slice.abort();
  const waiter = submitted.abortResolution;
  assert.ok(waiter, "Stop registers an abort waiter for the submission");
  reject(new Error("Stop rejected"));
  await assert.rejects(stopping, /Stop rejected/);
  assert.equal(await waiter, false);
});

test("a failed Stop does not replace a newer submitted draft", async t => {
  const f = fixture();
  const newer = { messageCountBeforeSend: 0, draft: { text: "new submission", fileReferences: [] } };
  let reject;
  t.mock.method(api, "abort", () => new Promise((_, fail) => { reject = fail; }));
  const stopping = f.slice.abort();
  f.runtime.submittedComposerDrafts.set("session", newer);
  reject(new Error("Stop rejected"));
  await assert.rejects(stopping, /Stop rejected/);
  assert.equal(f.runtime.submittedComposerDrafts.get("session"), newer);
  assert.equal(f.state().isRunning, true);
});

test("a failed Stop drops only the permission cards whose denial the Host settled", async t => {
  const denied = { requestId: "denied", sessionId: "session" };
  const gone = { requestId: "gone", sessionId: "session" };
  const unreachable = { requestId: "unreachable", sessionId: "session" };
  const f = fixture({ pendingPermissions: { session: [denied, gone, unreachable] } });
  t.mock.method(api, "abort", async () => { throw new Error("Stop rejected"); });
  t.mock.method(api, "resolvePermission", async ({ requestId }) => {
    if (requestId === "denied") return { ok: true };
    if (requestId === "gone") throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    throw new Error("disconnected");
  });
  await assert.rejects(f.slice.abort(), /Stop rejected/);
  assert.deepEqual(f.state().pendingPermissions.session, [unreachable]);
  assert.equal(f.state().isRunning, true);
});
