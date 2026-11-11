import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

for (const rejectFirst of [false, true]) test(`rapid idle model changes stay ordered (first write fails: ${rejectFirst})`, async t => {
  let state = { activeSessionId: "session", sessions: [{ id: "session", mode: "agent", modelId: "original" }], runningSessions: {}, pendingPlans: {}, sessionMeta: {}, planningStates: {}, retainedTranscripts: {} };
  const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const coordination = createSessionCoordination({ ...access, runtime });
  const slice = createSessionSlice({ ...access, runtime, ...coordination });
  const writes = [];
  const resolvers = [];
  t.mock.method(api, "configureSession", (id, config) => {
    writes.push(config);
    return new Promise((resolve, reject) => resolvers.push(() => {
      if (writes[0] === config && rejectFirst) reject(new Error("configuration unavailable"));
      else resolve({ session: { id, ...config } });
    }));
  });
  const first = slice.configureActiveSession({ mode: "agent", modelId: "first", thinkingLevel: "off" });
  const second = slice.configureActiveSession({ mode: "agent", modelId: "second", thinkingLevel: "off" });
  const outcome = rejectFirst ? assert.rejects(first, /configuration unavailable/) : first;
  assert.equal(writes.length, 1, "one authoritative configuration write may be in flight");
  resolvers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].modelId, "second");
  resolvers[1]();
  await Promise.all([outcome, second]);
  assert.equal(state.sessions[0].modelId, "second");
});
