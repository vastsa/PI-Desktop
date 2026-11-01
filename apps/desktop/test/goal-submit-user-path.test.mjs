import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await build({ stdin: { resolveDir: root, contents: `
export { createQueueSlice } from './apps/desktop/src/stores/slices/queue-slice';
export { createSessionRuntime } from './apps/desktop/src/stores/runtime/session-runtime';
export { withoutRecordKey, viewingSessionIdForPrompt, messageErrorFromUnknown, assistantErrorMessage } from './apps/desktop/src/stores/helpers/store-helpers';
export { IPC } from './packages/shared/src/index';
` }, bundle: true, write: false, platform: "node", format: "esm", nodePaths: [path.join(root, "apps/desktop/node_modules")],
  alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") } });
const modules = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const { createQueueSlice, createSessionRuntime, IPC, ...helpers } = modules;

test("Composer send public path uses start only for idle local Goal; busy send queues and historical approval remains blocking", async () => {
  const oldWindow = globalThis.window;
  const calls = [];
  globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === IPC.invoke.agentQueuePush) return { ok: true, data: { ...payload, id: "queued", createdAt: "2026-01-01T00:00:00Z" } };
    if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries: [] } };
    if (channel === IPC.invoke.goalsStart || channel === IPC.invoke.agentPrompt) return { ok: true, data: { accepted: true, turnId: "turn" } };
    throw new Error(`Unexpected boundary ${channel}`);
  } } };
  try {
    for (const mode of ["goal", "agent", "plan"]) {
      let state = { activeSessionId: "s", sessions: [{ id: "s", source: "desktop", mode, title: "Research export" }], messages: [],
        pendingPlans: {}, runningSessions: {}, queuedPrompts: {}, retainedTranscripts: {}, retainedSessionIds: [], latestTurnResults: {}, sessionOutcomes: {},
        rememberModel() {}, showToast: assert.fail };
      const access = { get: () => state, set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
      const runtime = createSessionRuntime(access);
      const slice = createQueueSlice({ ...access, runtime, ...helpers, promptAttachmentsFromDraft: () => [], materializeDraftSession: assert.fail });
      Object.assign(state, slice);
      assert.equal(await slice.sendPrompt("Export citations"), true);
      const sent = calls.pop(); assert.equal(sent.channel, mode === "goal" ? IPC.invoke.goalsStart : IPC.invoke.agentPrompt);
      if (mode === "goal") {
        assert.equal(Object.hasOwn(sent.payload, "budget"), false, "host snapshots saved defaults, not renderer drafts");
        assert.equal(state.sessions[0].mode, "agent", "successful Goal selection is one-shot");
        assert.equal(runtime.submittedComposerDrafts.get("s")?.goalStart, true, "Goal startup is not a retractable ordinary prompt");
      }
      assert.equal(state.messages[0].role, "user", "real runtime inserts the optimistic user message");
      assert.equal(await slice.sendPrompt("Prioritize the bibliography"), true);
      assert.ok(calls.some((call) => call.channel === IPC.invoke.agentQueuePush), "busy user input retains queue priority path");
      assert.ok(calls.every((call) => call.channel !== IPC.invoke.goalsStart));
      calls.length = 0;
      state.pendingPlans.s = { status: "pending", kind: "goal" };
      assert.equal(await slice.sendPrompt("Do not bypass historical approval"), false);
      assert.equal(calls.length, 0);
    }
  } finally { globalThis.window = oldWindow; }
});

test("stopped Goal admission never sends resume and restores the failed send with a toast", async () => {
  const oldWindow = globalThis.window; const calls = []; const toasts = [];
  globalThis.window = { piDesktop: { invoke: async (channel) => {
    calls.push(channel);
    return { ok: false, error: { code: "GOAL_RESUME_REQUIRED", message: "Resume this goal explicitly" } };
  } } };
  try {
    let state = { activeSessionId: "s", sessions: [{ id: "s", source: "desktop", mode: "goal", title: "Research export" }], messages: [],
      pendingPlans: {}, runningSessions: {}, queuedPrompts: {}, retainedTranscripts: {}, retainedSessionIds: [], latestTurnResults: {}, sessionOutcomes: {},
      rememberModel() {}, showToast: (message) => toasts.push(message) };
    const access = { get: () => state, set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
    const runtime = createSessionRuntime(access);
    const slice = createQueueSlice({ ...access, runtime, ...helpers, promptAttachmentsFromDraft: () => [], materializeDraftSession: assert.fail });
    Object.assign(state, slice);
    assert.equal(await slice.sendPrompt("Continue"), false);
    assert.deepEqual(calls, [IPC.invoke.goalsStart]);
    assert.deepEqual(toasts, ["Resume this goal explicitly"]);
    assert.equal(state.runningSessions.s, false);
    assert.ok(state.messages.every((message) => message.role !== "user"));
  } finally { globalThis.window = oldWindow; }
});


function userPathHarness(mode = "agent", running = true) {
  let state = { activeSessionId: "s", sessions: [{ id: "s", source: "desktop", mode, title: "Research export" }], messages: [],
    agentStatuses: { s: { currentTurnId: "active-goal-turn" } }, pendingPlans: {}, runningSessions: { s: running }, isRunning: running,
    queuedPrompts: {}, retainedTranscripts: {}, retainedSessionIds: [], latestTurnResults: {}, sessionOutcomes: {},
    rememberModel() {}, showToast: assert.fail };
  const access = { get: () => state, set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createQueueSlice({ ...access, runtime, ...helpers, promptAttachmentsFromDraft: () => [], materializeDraftSession: assert.fail });
  Object.assign(state, slice);
  return { ...access, runtime, slice };
}

test("running Goal accepts immediate Agent guidance without Stop, mode change or losing the active turn", async () => {
  const previous = globalThis.window, calls = [], h = userPathHarness();
  globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    assert.equal(channel, IPC.invoke.agentSteer);
    return { ok: true, data: { accepted: true } };
  } } };
  try {
    assert.equal(await h.slice.steerPrompt("Include the new requirements"), true);
    assert.equal(calls[0].payload.expectedTurnId, "active-goal-turn");
    assert.equal(h.get().messages[0].steering, true);
    assert.equal(h.get().messages[0].content, "Include the new requirements");
    assert.equal(h.get().runningSessions.s, true);
    assert.equal(h.get().agentStatuses.s.currentTurnId, "active-goal-turn");
    assert.equal(h.get().sessions[0].mode, "agent");
  } finally { globalThis.window = previous; }
});

test("explicit new Goal during running work uses replacement ingress and resets staged Goal choice", async () => {
  const previous = globalThis.window, calls = [], h = userPathHarness("goal");
  h.runtime.pendingSessionConfigurations.set("s", { mode: "goal", thinkingLevel: "high" });
  globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
    calls.push({ channel, payload }); assert.equal(channel, IPC.invoke.goalsStart);
    return { ok: true, data: { accepted: true, turnId: "queued-new-goal" } };
  } } };
  try {
    assert.equal(await h.slice.sendPrompt("Replace with this objective"), true);
    assert.equal(calls.length, 1); assert.equal(calls[0].payload.content, "Replace with this objective");
    assert.equal(h.get().sessions[0].mode, "agent");
    assert.deepEqual(h.runtime.pendingSessionConfigurations.get("s"), { mode: "agent", thinkingLevel: "high" });
  } finally { globalThis.window = previous; }
});

test("successful Goal start cannot overwrite a newer Composer selection while awaiting admission", async () => {
  const previous = globalThis.window, h = userPathHarness("goal", false);
  let release; const response = new Promise(done => { release = done; });
  globalThis.window = { piDesktop: { invoke: (channel) => { assert.equal(channel, IPC.invoke.goalsStart); return response; } } };
  try {
    const starting = h.slice.sendPrompt("An objective");
    h.set(state => ({ sessions: state.sessions.map(session => ({ ...session, mode: "plan" })) }));
    release({ ok: true, data: { accepted: true, turnId: "new-goal" } });
    assert.equal(await starting, true); assert.equal(h.get().sessions[0].mode, "plan");
  } finally { globalThis.window = previous; }
});


test("unrelated session refresh cannot suppress one-shot Agent reset", async () => {
  const previous = globalThis.window, h = userPathHarness("goal", false);
  let release; const response = new Promise(done => { release = done; });
  globalThis.window = { piDesktop: { invoke: () => response } };
  try {
    const starting = h.slice.sendPrompt("An objective");
    h.set(state => ({ sessions: state.sessions.map(session => ({ ...session, title: "Updated title" })) }));
    release({ ok: true, data: { accepted: true, turnId: "new-goal" } });
    assert.equal(await starting, true); assert.equal(h.get().sessions[0].mode, "agent");
    assert.equal(h.get().sessions[0].title, "Updated title");
  } finally { globalThis.window = previous; }
});
