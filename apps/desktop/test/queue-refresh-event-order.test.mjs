import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createQueueSlice } = await import("../src/stores/slices/queue-slice.ts");
const { api } = await import("../src/lib/api.ts");

const entry = id => ({ id, sessionId: "session", content: id, createdAt: "2026-11-10T00:00:00Z" });
function harness() {
  let state = { queuedPrompts: {} };
  const slice = createQueueSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } });
  return { slice, state: () => state };
}

test("a late queue read cannot resurrect a prompt already delivered by a queue event", async t => {
  const h = harness();
  h.slice.applyQueueChanged({ sessionId: "session", entries: [entry("first"), entry("second")] });
  let finish;
  t.mock.method(api, "listQueuedPrompts", () => new Promise(resolve => { finish = resolve; }));
  const reading = h.slice.refreshQueuedPrompts("session");
  h.slice.applyQueueChanged({ sessionId: "session", entries: [entry("second")] });
  finish({ entries: [entry("first"), entry("second")] });
  await reading;
  assert.deepEqual(h.state().queuedPrompts.session.map(item => item.id), ["second"]);
});

test("the newest queue refresh wins when responses arrive in reverse order", async t => {
  const h = harness();
  const finishes = [];
  t.mock.method(api, "listQueuedPrompts", () => new Promise(resolve => { finishes.push(resolve); }));
  const oldRead = h.slice.refreshQueuedPrompts("session");
  const latest = h.slice.refreshQueuedPrompts("session");
  finishes[1]({ entries: [entry("latest")] });
  await latest;
  finishes[0]({ entries: [entry("old")] });
  await oldRead;
  assert.deepEqual(h.state().queuedPrompts.session.map(item => item.id), ["latest"]);
});

test("an event in a different session does not invalidate a successful read", async t => {
  const h = harness();
  let finish;
  t.mock.method(api, "listQueuedPrompts", () => new Promise(resolve => { finish = resolve; }));
  const reading = h.slice.refreshQueuedPrompts("session");
  h.slice.applyQueueChanged({ sessionId: "other", entries: [] });
  finish({ entries: [entry("saved")] });
  await reading;
  assert.equal(h.state().queuedPrompts.session[0].id, "saved");
});
