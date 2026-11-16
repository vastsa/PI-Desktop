import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

test("a late bounded session read preserves a newer idle edit cache", async t => {
  const old = [{ id: "answer", role: "assistant", content: "before edit" }];
  const edited = [{ ...old[0], content: "after edit" }];
  const state = { activeSessionId: "other", retainedTranscripts: {}, runningSessions: {} };
  const runtime = createSessionRuntime({ get: () => state, set() {} });
  runtime.cacheSessionTranscript("session", old, { messageStart: 10, hasMoreBefore: true });
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));
  const pending = runtime.loadSessionDetail("session", { messageLimit: 100, contentLimit: 65536 });
  runtime.cacheSessionTranscript("session", edited, { messageStart: 0, hasMoreBefore: false });
  finish({ session: { id: "session", messages: old, messageStart: 10, hasMoreBefore: true } });
  assert.deepEqual((await pending).session.messages, old, "the reader still receives its response");
  assert.equal(runtime.sessionTranscriptCache.get("session"), edited);
  assert.deepEqual(runtime.sessionHistoryCache.get("session"), { messageStart: 0, hasMoreBefore: false });
});

test("an unchanged bounded read still hydrates the transcript and its window", async t => {
  const state = { retainedTranscripts: {}, runningSessions: {} };
  const runtime = createSessionRuntime({ get: () => state, set() {} });
  const messages = [{ id: "answer", role: "assistant", content: "saved answer" }];
  t.mock.method(api, "getSession", async () => ({ session: { id: "session", messages, messageStart: 5, hasMoreBefore: true } }));
  await runtime.loadSessionDetail("session", { messageLimit: 100, contentLimit: 65536 });
  assert.deepEqual(runtime.sessionTranscriptCache.get("session"), messages);
  assert.deepEqual(runtime.sessionHistoryCache.get("session"), { messageStart: 5, hasMoreBefore: true, contentLimited: true });
});

test("live session reads still merge a streamed tail rather than discarding it", async t => {
  const saved = { id: "prompt", role: "user", content: "question" };
  const streamed = { id: "live", role: "assistant", content: "partial", status: "streaming" };
  const state = { retainedTranscripts: {}, runningSessions: { session: true } };
  const runtime = createSessionRuntime({ get: () => state, set() {} });
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));
  const reading = runtime.loadSessionDetail("session", { messageLimit: 100 });
  runtime.cacheSessionTranscript("session", [saved, streamed]);
  finish({ session: { id: "session", messages: [saved] } });
  await reading;
  assert.deepEqual(runtime.sessionTranscriptCache.get("session"), [saved, streamed]);
});
