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
      if (mode === "goal") assert.equal(Object.hasOwn(sent.payload, "budget"), false, "host snapshots saved defaults, not renderer drafts");
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
