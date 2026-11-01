import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await build({ stdin: { resolveDir: root, contents: `
export { createSessionSlice } from './apps/desktop/src/stores/slices/session-slice';
export { createSessionRuntime } from './apps/desktop/src/stores/runtime/session-runtime';
export { createSessionCoordination } from './apps/desktop/src/stores/runtime/session-coordination';
export { withoutRecordKey } from './apps/desktop/src/stores/helpers/store-helpers';
export { IPC } from './packages/shared/src/index';
` }, bundle: true, write: false, platform: "node", format: "esm", nodePaths: [path.join(root, "apps/desktop/node_modules")],
  alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") } });
const { createSessionSlice, createSessionRuntime, createSessionCoordination, withoutRecordKey, IPC } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };
function harness(mode, { running = true, pending = false } = {}) {
  let state = { activeSessionId: "s", sessions: [{ id: "s", source: "desktop", mode, permissionMode: "ask", title: "Citations" }, { id: "other", source: "desktop", mode: "agent" }],
    runningSessions: { s: running }, isRunning: running, pendingPlans: pending ? { s: { status: "pending", kind: "goal" } } : {}, sessionMeta: {}, planningStates: {}, showToast: assert.fail };
  const access = { get: () => state, set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const coordination = createSessionCoordination({ ...access, runtime, withoutRecordKey, decorateSessions: (sessions) => sessions, untitledTaskTitle: () => "New task" });
  const slice = createSessionSlice({ ...access, runtime, withoutRecordKey, ...coordination, decorateSessions: (sessions) => sessions });
  Object.assign(state, slice);
  return { ...access, runtime, coordination, slice };
}

for (const nextMode of ["agent", "plan"]) test(`running Goal → ${nextMode} immediately aborts, then normal turn-end flush applies merged selection`, async () => {
  const previous = globalThis.window; const abort = deferred(); const calls = []; const h = harness("goal");
  globalThis.window = { piDesktop: { invoke: (channel, ...args) => {
    calls.push({ channel, args });
    if (channel === IPC.invoke.agentAbort) return abort.promise;
    if (channel === IPC.invoke.sessionConfigure) return Promise.resolve({ ok: true, data: { session: { ...h.get().sessions[0], ...args[1] } } });
    throw new Error(`Unexpected ${channel}`);
  } } };
  try {
    const changing = h.slice.configureActiveSession({ mode: nextMode, thinkingLevel: "high" });
    assert.deepEqual(calls, [{ channel: IPC.invoke.agentAbort, args: [{ sessionId: "s" }] }], "pause/abort dispatches synchronously, before turn-end or configuration completion");
    assert.equal(h.runtime.pendingSessionConfigurations.get("s").mode, nextMode);
    assert.equal(h.get().runningSessions.s, true, "host turn-end still owns running state");
    await h.slice.configureActiveSession({ mode: nextMode, thinkingLevel: "high", permissionMode: "accept-edits" });
    assert.equal(calls.length, 1, "further staged selection does not start another abort");
    h.set({ activeSessionId: "other" });
    abort.resolve({ ok: true, data: {} }); await changing;
    assert.equal(h.get().activeSessionId, "other");
    h.set({ runningSessions: { s: false } }); await h.coordination.flushPendingSessionConfiguration("s");
    assert.equal(calls[1].channel, IPC.invoke.sessionConfigure);
    assert.equal(calls[1].args[0], "s");
    assert.deepEqual(calls[1].args[1], { mode: nextMode, thinkingLevel: "high", permissionMode: "accept-edits" });
    assert.equal(h.runtime.pendingSessionConfigurations.has("s"), false);
    assert.equal(h.get().planningStates.s, nextMode === "plan" ? "planning" : "inactive");
  } finally { globalThis.window = previous; }
});

for (const mode of ["agent", "plan", "goal"]) test(`${mode}: same-mode permissions remain staged; Agent/Plan mode switches do not abort`, async () => {
  const previous = globalThis.window; const calls = []; const h = harness(mode);
  globalThis.window = { piDesktop: { invoke: async (channel) => { calls.push(channel); throw new Error("Unexpected IPC before turn-end"); } } };
  try {
    for (const permissionMode of ["ask", "accept-edits", "auto"]) {
      await h.slice.configureActiveSession({ mode, thinkingLevel: "medium", permissionMode });
      assert.equal(h.get().sessions[0].permissionMode, permissionMode);
      assert.equal(h.runtime.pendingSessionConfigurations.get("s").permissionMode, permissionMode);
    }
    if (mode !== "goal") await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "medium" });
    assert.deepEqual(calls, []);
  } finally { globalThis.window = previous; }
});

test("historical pending Goal approval still prevents configuration and abort", async () => {
  const previous = globalThis.window; const h = harness("goal", { pending: true });
  globalThis.window = { piDesktop: { invoke: assert.fail } };
  try {
    await h.slice.configureActiveSession({ mode: "agent", thinkingLevel: "medium" });
    assert.equal(h.runtime.pendingSessionConfigurations.size, 0); assert.equal(h.get().sessions[0].mode, "goal");
  } finally { globalThis.window = previous; }
});

test("failed mode-exit abort rejects visibly and preserves staged intent without claiming the turn stopped", async () => {
  const previous = globalThis.window; const h = harness("goal");
  globalThis.window = { piDesktop: { invoke: async () => ({ ok: false, error: { code: "HOST_UNAVAILABLE", message: "Host unavailable" } }) } };
  try {
    await assert.rejects(h.slice.configureActiveSession({ mode: "agent", thinkingLevel: "high" }), /Host unavailable/);
    assert.equal(h.get().runningSessions.s, true); assert.equal(h.runtime.pendingSessionConfigurations.get("s").mode, "agent");
  } finally { globalThis.window = previous; }
});

test("idle Goal exit uses configure IPC; main owns pause/abort on that path", async () => {
  const previous = globalThis.window; const h = harness("goal", { running: false }); const calls = [];
  globalThis.window = { piDesktop: { invoke: async (channel, sessionId, config) => {
    calls.push(channel); assert.equal(sessionId, "s");
    return { ok: true, data: { session: { ...h.get().sessions[0], ...config } } };
  } } };
  try {
    await h.slice.configureActiveSession({ mode: "agent", thinkingLevel: "high" });
    assert.deepEqual(calls, [IPC.invoke.sessionConfigure]); assert.equal(h.get().sessions[0].mode, "agent");
  } finally { globalThis.window = previous; }
});
