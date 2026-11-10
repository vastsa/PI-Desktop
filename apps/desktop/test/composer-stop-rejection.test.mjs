import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

test("a failed Composer Stop preserves streaming rows and its submitted draft for retry", async t => {
  const rows = [{ id: "prompt", role: "user", content: "work" }, { id: "answer", role: "assistant", content: "partial", status: "streaming" }];
  let state = { activeSessionId: "session", sessions: [{ id: "session", source: "desktop" }], messages: rows, isRunning: true, runningSessions: { session: true }, retainedTranscripts: {}, pendingPermissions: {}, sessionHistory: {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const submitted = { messageCountBeforeSend: 0, draft: { text: "work", fileReferences: [] } };
  runtime.submittedComposerDrafts.set("session", submitted);
  const slice = createTranscriptSlice({ ...access, runtime, flushPendingSessionConfiguration: async () => {} });
  t.mock.method(api, "abort", async () => { throw new Error("host disconnected"); });
  await assert.rejects(slice.abort(), /host disconnected/);
  assert.equal(state.isRunning, true);
  assert.equal(state.runningSessions.session, true);
  assert.equal(state.messages, rows);
  assert.equal(runtime.submittedComposerDrafts.get("session"), submitted);
  assert.equal(submitted.abortResolution, undefined, "a failed stop must not leave a pending abort waiter");
  t.mock.method(api, "abort", async () => ({ ok: true }));
  await slice.abort();
  assert.equal(state.isRunning, false);
  assert.equal(state.runningSessions.session, false);
  assert.equal(state.messages[1].status, "aborted");
  assert.equal(runtime.submittedComposerDrafts.has("session"), false);
});

test("a rejected Stop does not remove pending permissions or a newer submitted draft", async t => {
  const permission = { requestId: "permission", sessionId: "session" };
  let state = { activeSessionId: "session", sessions: [{ id: "session" }], messages: [], isRunning: true, runningSessions: { session: true }, retainedTranscripts: {}, pendingPermissions: { session: [permission] }, sessionHistory: {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const newer = { messageCountBeforeSend: 0, draft: { text: "new submission", fileReferences: [] } };
  const slice = createTranscriptSlice({ ...access, runtime });
  let reject;
  t.mock.method(api, "abort", () => new Promise((_, fail) => { reject = fail; }));
  t.mock.method(api, "resolvePermission", async () => { throw new Error("disconnected"); });
  const stopping = slice.abort();
  runtime.submittedComposerDrafts.set("session", newer);
  reject(new Error("Stop rejected"));
  await assert.rejects(stopping, /Stop rejected/);
  assert.equal(state.pendingPermissions.session[0], permission);
  assert.equal(runtime.submittedComposerDrafts.get("session"), newer);
  assert.equal(state.isRunning, true);
});
