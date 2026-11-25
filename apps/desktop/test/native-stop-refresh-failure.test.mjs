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

for (const source of ["pi-native", "remote"]) test(`a turn started during the ${source} Stop's settled read keeps its optimistic state`, async t => {
  const id = source === "remote" ? "remote:fixture" : "native-pi:fixture";
  const stale = [{ id: "answer", role: "assistant", content: "settled snapshot" }];
  let state = {
    activeSessionId: id,
    sessions: [{ id, source, capabilities: { canStop: true } }],
    messages: stale,
    isRunning: true,
    runningSessions: { [id]: true },
    retainedTranscripts: {},
  };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createTranscriptSlice({ ...access, runtime });
  let resolveGetSession;
  t.mock.method(api, "abort", async () => ({ ok: true }));
  t.mock.method(api, "getSession", () => new Promise((resolve) => { resolveGetSession = resolve; }));
  const stopping = slice.abort();
  await new Promise((resolve) => setImmediate(resolve));
  // The isRunning clear unlocked the composer; a new prompt started and its
  // optimistic row is the live transcript now.
  const optimistic = [{ id: "user-2", role: "user", content: "next prompt" }];
  state = { ...state, messages: optimistic, isRunning: true, runningSessions: { [id]: true } };
  resolveGetSession({ session: { id, messages: stale } });
  await stopping;
  assert.equal(state.messages, optimistic, "the settled snapshot must not replace the live turn");
  assert.equal(state.isRunning, true, "the new turn's spinner stays on");
  assert.equal(state.runningSessions[id], true);
  assert.equal(runtime.sessionTranscriptCache.get(id), undefined,
    "the stale snapshot must not poison the transcript cache");
  assert.equal(state.retainedTranscripts[id], undefined,
    "the stale snapshot must not become the retained transcript");
});

for (const source of ["pi-native", "remote"]) test(`the settled read still lands when no turn restarted (${source})`, async t => {
  const id = source === "remote" ? "remote:fixture" : "native-pi:fixture";
  const settled = [{ id: "answer", role: "assistant", content: "stopped answer" }];
  let state = {
    activeSessionId: id,
    sessions: [{ id, source, capabilities: { canStop: true } }],
    messages: [{ id: "answer", role: "assistant", content: "partial", status: "streaming" }],
    isRunning: true,
    runningSessions: { [id]: true },
    retainedTranscripts: {},
  };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createTranscriptSlice({ ...access, runtime });
  t.mock.method(api, "abort", async () => ({ ok: true }));
  t.mock.method(api, "getSession", async () => ({ session: { id, messages: settled } }));
  await slice.abort();
  assert.deepEqual(state.messages, settled);
  assert.equal(state.isRunning, false);
  assert.equal(state.runningSessions[id], false);
  assert.deepEqual(runtime.sessionTranscriptCache.get(id), settled);
});

test("a rejected native Stop keeps running and does not attempt a detail read", async t => {
  let state = { activeSessionId: "native-pi:fixture", sessions: [{ id: "native-pi:fixture", source: "pi-native" }], isRunning: true, runningSessions: { "native-pi:fixture": true } };
  const slice = createTranscriptSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, runtime: { submittedComposerDrafts: new Map() } });
  t.mock.method(api, "abort", async () => { throw new Error("abort failed"); });
  t.mock.method(api, "getSession", assert.fail);
  await assert.rejects(slice.abort(), /abort failed/);
  assert.equal(state.isRunning, true);
});
