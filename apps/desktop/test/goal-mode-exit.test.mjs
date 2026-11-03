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

for (const nextMode of ["agent", "plan"]) test(`running Goal → ${nextMode} does not abort and flushes merged selection at the boundary`, async () => {
  const previous = globalThis.window; const calls = []; const h = harness("goal");
  globalThis.window = { piDesktop: { invoke: async (channel, ...args) => {
    calls.push({ channel, args });
    assert.equal(channel, IPC.invoke.sessionConfigure);
    return { ok: true, data: { session: { ...h.get().sessions[0], ...args[1] } } };
  } } };
  try {
    await h.slice.configureActiveSession({ mode: nextMode, thinkingLevel: "high" });
    assert.deepEqual(calls, [], "mode selection must not pause or abort the Goal");
    assert.equal(h.runtime.pendingSessionConfigurations.get("s").mode, nextMode);
    assert.equal(h.get().runningSessions.s, true);
    await h.slice.configureActiveSession({ mode: nextMode, thinkingLevel: "high", permissionMode: "accept-edits" });
    h.set({ activeSessionId: "other", runningSessions: { s: false } });
    await h.coordination.flushPendingSessionConfiguration("s");
    assert.equal(h.get().activeSessionId, "other");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["s", { mode: nextMode, thinkingLevel: "high", permissionMode: "accept-edits" }]);
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

test("successful removal resets only input preference and retains pending non-mode settings through turn-end", async () => {
  const previous = globalThis.window; const calls = []; const h = harness("goal");
  const frozen = { planningStates: { s: "executing" }, planCheckpoints: { s: { status: "executing", kind: "plan" } }, messages: [{ id: "live", content: "Still streaming" }] };
  h.set(frozen);
  globalThis.window = { piDesktop: { invoke: async (channel, ...args) => {
    calls.push({ channel, args }); assert.equal(channel, IPC.invoke.sessionConfigure);
    return { ok: true, data: { session: { ...h.get().sessions[0], ...args[1] } } };
  } } };
  try {
    await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "high", providerId: "p", modelId: "m", permissionMode: "accept-edits", fastMode: true });
    const removed = h.slice.prepareGoalRemoval("s");
    await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "high", permissionMode: "auto" });
    removed();
    assert.equal(h.get().sessions[0].mode, "agent");
    assert.equal(h.get().sessions[0].permissionMode, "auto");
    assert.deepEqual(h.runtime.pendingSessionConfigurations.get("s"), { mode: "agent", thinkingLevel: "high", providerId: "p", modelId: "m", permissionMode: "auto", fastMode: true });
    assert.equal(h.get().isRunning, true); assert.equal(h.get().runningSessions.s, true);
    for (const key of Object.keys(frozen)) assert.equal(h.get()[key], frozen[key], key + " must remain frozen");
    assert.deepEqual(calls, [], "removal reconciliation must not abort, configure or refresh");
    h.set({ runningSessions: { s: false } });
    await h.coordination.flushPendingSessionConfiguration("s");
    assert.equal(calls.length, 1); assert.equal(calls[0].args[1].mode, "agent");
    assert.equal(calls[0].args[1].modelId, "m");
    assert.equal(h.get().sessions[0].mode, "agent");
  } finally { globalThis.window = previous; }
});

for (const mode of ["agent", "plan", "goal"]) test("removal preserves a newer explicit input-mode selection: " + mode, async () => {
  const h = harness("goal"); const removed = h.slice.prepareGoalRemoval("s");
  await h.slice.configureActiveSession({ mode: mode === "goal" ? "plan" : mode, thinkingLevel: "high" });
  if (mode === "goal") await h.slice.configureActiveSession({ mode, thinkingLevel: "high" });
  removed();
  assert.equal(h.get().sessions[0].mode, mode);
  assert.equal(h.runtime.pendingSessionConfigurations.get("s").mode, mode);
});

test("a new Goal selection after host input reset is newer than the previous Goal intent", async () => {
  const h = harness("plan");
  await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "high" });
  h.set({ sessions: h.get().sessions.map(session => session.id === "s" ? { ...session, mode: "agent" } : session) });
  const removed = h.slice.prepareGoalRemoval("s");
  await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "high" });
  removed();
  assert.equal(h.get().sessions[0].mode, "goal");
  assert.equal(h.runtime.pendingSessionConfigurations.get("s").mode, "goal");
});

test("removal cannot reset a switched or foreign session", () => {
  const h = harness("goal"); const removed = h.slice.prepareGoalRemoval("s");
  h.set({ activeSessionId: "other" }); removed();
  assert.equal(h.get().sessions[0].mode, "goal"); assert.equal(h.get().sessions[1].mode, "agent");
  h.set({ activeSessionId: "s", sessions: [{ ...h.get().sessions[0], source: "remote" }] });
  h.slice.prepareGoalRemoval("s")(); assert.equal(h.get().sessions[0].mode, "goal");
});

test("a stale configuration flush cannot restore Goal or clobber newer pending model and permissions", async () => {
  const previous = globalThis.window; const h = harness("goal"); const replies = []; const entered = [];
  let second; const secondStarted = new Promise(resolve => second = resolve);
  globalThis.window = { piDesktop: { invoke: (channel, ...args) => {
    assert.equal(channel, IPC.invoke.sessionConfigure); entered.push(args);
    return new Promise(resolve => { replies.push(session => resolve({ ok: true, data: { session } })); if (entered.length === 2) second(); });
  } } };
  try {
    await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "medium", permissionMode: "ask" });
    h.set({ runningSessions: { s: false }, planningStates: { s: "executing" } });
    const flush = h.coordination.flushPendingSessionConfiguration("s");
    const old = { ...h.get().sessions[0] }; const removed = h.slice.prepareGoalRemoval("s");
    await h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "high", modelId: "new-model", permissionMode: "auto" });
    removed(); replies[0](old); await secondStarted;
    assert.equal(h.get().sessions[0].mode, "agent");
    assert.equal(h.get().sessions[0].modelId, "new-model");
    assert.equal(h.get().sessions[0].permissionMode, "auto");
    assert.equal(h.get().planningStates.s, "executing");
    assert.equal(entered[1][1].mode, "agent");
    replies[1]({ ...h.get().sessions[0], ...entered[1][1] }); await flush;
    assert.equal(h.get().sessions[0].mode, "agent");
    assert.equal(h.runtime.pendingSessionConfigurations.has("s"), false);
  } finally { globalThis.window = previous; }
});

test("an idle configure reply cannot restore a preference reset by successful removal", async () => {
  const previous = globalThis.window; const h = harness("goal", { running: false }); let reply;
  globalThis.window = { piDesktop: { invoke: (channel) => {
    assert.equal(channel, IPC.invoke.sessionConfigure);
    return new Promise(resolve => reply = session => resolve({ ok: true, data: { session } }));
  } } };
  try {
    const config = h.slice.configureActiveSession({ mode: "goal", thinkingLevel: "high" });
    h.slice.prepareGoalRemoval("s")(); reply({ ...h.get().sessions[0], mode: "goal" }); await config;
    assert.equal(h.get().sessions[0].mode, "agent");
  } finally { globalThis.window = previous; }
});

test("mode selection does not depend on an available abort transport", async () => {
  const previous = globalThis.window; const h = harness("goal");
  globalThis.window = { piDesktop: { invoke: assert.fail } };
  try {
    await h.slice.configureActiveSession({ mode: "agent", thinkingLevel: "high" });
    assert.equal(h.get().runningSessions.s, true);
    assert.equal(h.runtime.pendingSessionConfigurations.get("s").mode, "agent");
  } finally { globalThis.window = previous; }
});
