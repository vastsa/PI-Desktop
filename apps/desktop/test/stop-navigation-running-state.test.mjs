import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

test("a Stop hydration finishing after navigation does not stop the visible session", async t => {
  const user = { id: "prompt", role: "user", content: "pending" };
  let state = { activeSessionId: "first", sessions: [{ id: "first" }, { id: "second" }], messages: [user], isRunning: true, runningSessions: { first: true, second: true }, pendingPermissions: {}, retainedTranscripts: {}, sessionHistory: {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const draft = { messageCountBeforeSend: 0, draft: { text: "pending", fileReferences: [] } };
  runtime.submittedComposerDrafts.set("first", draft);
  const slice = createTranscriptSlice({ ...access, runtime, flushPendingSessionConfiguration: async () => {} });
  t.mock.method(api, "abort", async () => ({}));
  let release;
  t.mock.method(api, "getSession", () => new Promise(resolve => { release = resolve; }));
  const stopping = slice.abort();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const secondRows = [{ id: "second-answer", role: "assistant", content: "live", status: "streaming" }];
  state = { ...state, activeSessionId: "second", messages: secondRows };
  release({ session: { messages: [user, { id: "first-answer", role: "assistant", content: "finished" }] } });
  await stopping;
  assert.equal(state.runningSessions.first, false);
  assert.equal(state.runningSessions.second, true);
  assert.equal(state.isRunning, true);
  assert.equal(state.messages, secondRows);
  assert.equal(runtime.submittedComposerDrafts.has("first"), false);
});

test("a synchronous navigation at hydration commit preserves the new session's running flag", async t => {
  const user = { id: "prompt", role: "user", content: "pending" };
  let state = { activeSessionId: "first", sessions: [{ id: "first" }], messages: [user], isRunning: true, runningSessions: { first: true, second: true }, pendingPermissions: {}, retainedTranscripts: {}, sessionHistory: {} };
  const other = [{ id: "second-answer", role: "assistant", content: "stream", status: "streaming" }];
  const access = { get: () => state, set: patch => {
    const update = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...update };
    if (update.sessionHistory) state = { ...state, activeSessionId: "second", messages: other, isRunning: true };
  } };
  const runtime = createSessionRuntime(access);
  const actions = createTranscriptSlice({ ...access, runtime, flushPendingSessionConfiguration: async () => {} });
  t.mock.method(api, "abort", async () => ({}));
  t.mock.method(api, "getSession", async () => ({ session: { messages: [user, { id: "answer", role: "assistant", content: "finished" }] } }));
  await actions.abort();
  assert.equal(state.activeSessionId, "second");
  assert.equal(state.isRunning, true);
  assert.equal(state.messages, other);
  assert.equal(state.runningSessions.first, false);
});
