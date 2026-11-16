import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

for (const source of ["pi-native", "remote"]) test(`confirmed ${source} Stop remains stopped if detail refresh fails`, async t => {
  const id = source === "remote" ? "remote:fixture" : "native-pi:fixture";
  const messages = [{ id: "answer", role: "assistant", content: "partial", status: "streaming" }];
  let state = { activeSessionId: id, sessions: [{ id, source, capabilities: { canStop: true } }], messages, isRunning: true, runningSessions: { [id]: true }, retainedTranscripts: {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createTranscriptSlice({ ...access, runtime });
  t.mock.method(api, "abort", async () => ({ ok: true }));
  t.mock.method(api, "getSession", async () => { throw new Error("detail disconnected"); });
  await assert.rejects(slice.abort(), /detail disconnected/);
  assert.equal(state.isRunning, false);
  assert.equal(state.runningSessions[id], false);
  assert.equal(state.messages, messages, "failed refresh preserves the known transcript");
});

test("a rejected native Stop keeps running and does not attempt a detail read", async t => {
  let state = { activeSessionId: "native-pi:fixture", sessions: [{ id: "native-pi:fixture", source: "pi-native" }], isRunning: true, runningSessions: { "native-pi:fixture": true } };
  const slice = createTranscriptSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, runtime: { submittedComposerDrafts: new Map() } });
  t.mock.method(api, "abort", async () => { throw new Error("abort failed"); });
  t.mock.method(api, "getSession", assert.fail);
  await assert.rejects(slice.abort(), /abort failed/);
  assert.equal(state.isRunning, true);
});
