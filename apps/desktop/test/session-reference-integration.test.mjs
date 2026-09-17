import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Bundle real renderer/shared source in memory: no built shared dist, disk fixture,
// Electron process, database, or network is needed. Only the public host seam is fake.
const host = {};
globalThis.__sessionReferenceTestHost = host;
const bundle = await build({
  stdin: {
    contents: `
      export * from "./apps/desktop/src/lib/session-reference-preferences.ts";
      export * from "./apps/desktop/src/lib/session-reference-budget.ts";
      export * from "./apps/desktop/src/lib/session-reference-prompt.ts";
      export { createQueueSlice } from "./apps/desktop/src/stores/slices/queue-slice.ts";
      export { stripSessionReferencePrompt, estimateSessionReferenceTokens } from "@pi-desktop/shared";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, write: false, platform: "node", format: "cjs", target: "node24",
  alias: { "@pi-desktop/shared": resolve(root, "packages/shared/src/index.ts") },
  plugins: [{
    name: "host-seam",
    setup(build) {
      build.onResolve({ filter: /(^|\/)lib\/api$|^\.\/api$/ }, () => ({ path: "api", namespace: "fixture" }));
      build.onResolve({ filter: /^i18next$/ }, () => ({ path: "i18n", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "api"
        ? "export const api = globalThis.__sessionReferenceTestHost;"
        : "export default { t: (key, args) => key + (args ? JSON.stringify(args) : '') };", loader: "js" }));
    },
  }],
});
const module = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(module, module.exports, require);
const lib = module.exports;
const sourceId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const text = `Compare @session:${sourceId}`;
const draft = () => ({ text, fileReferences: [{ kind: "session", path: sourceId, name: "Source" }, { kind: "file", path: "notes.md", name: "notes.md" }] });
const message = (id, role, content, extra = {}) => ({ id, role, content, createdAt: "2026-01-01T00:00:00Z", ...extra });
const source = (messages = [message("u", "user", "Question"), message("a", "assistant", "Complete answer")], extra = {}) => ({
  session: { id: sourceId, title: "Source", messages, messageStart: 0, messageEnd: messages.length, hasMoreBefore: false, ...extra },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const resetHost = (methods = {}) => {
  for (const key of Object.keys(host)) delete host[key];
  Object.assign(host, methods);
};
const modelBudget = (extra = {}) => lib.calculateSessionReferenceBudget({
  session: { providerId: "p", modelId: "m" },
  providers: [{ id: "p", models: [] }],
  providerModels: { p: [{ modelId: "m", contextWindow: 1000 }] },
  messages: [], currentInput: "", ...extra,
});

function withStorage(value, callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value });
  try { callback(); } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("preference validates exact percentages and persists the renderer-only key", () => {
  for (const value of [undefined, null, "50", 0, -1, 26, NaN, Infinity, {}]) {
    assert.equal(lib.normalizeSessionReferenceBudgetPercent(value), 25);
  }
  const data = new Map();
  withStorage({ getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) }, () => {
    assert.equal(lib.getSessionReferenceBudgetPercent(), 25);
    for (const value of [10, 25, 50, 100]) {
      lib.setSessionReferenceBudgetPercent(value);
      assert.equal(data.get("pi-desktop:session-reference-budget-percent"), String(value));
      assert.equal(lib.getSessionReferenceBudgetPercent(), value);
    }
    lib.setSessionReferenceBudgetPercent(15);
    assert.equal(lib.getSessionReferenceBudgetPercent(), 25);
    data.set("pi-desktop:session-reference-budget-percent", "corrupt");
    assert.equal(lib.getSessionReferenceBudgetPercent(), 25);
  });
});

test("preference tolerates missing, blocked and full localStorage", () => {
  withStorage(undefined, () => {
    assert.equal(lib.getSessionReferenceBudgetPercent(), 25);
    assert.doesNotThrow(() => lib.setSessionReferenceBudgetPercent(50));
  });
  withStorage({ getItem() { throw Error("blocked"); }, setItem() { throw Error("full"); } }, () => {
    assert.equal(lib.getSessionReferenceBudgetPercent(), 25);
    assert.doesNotThrow(() => lib.setSessionReferenceBudgetPercent(100));
  });
  withStorage(undefined, () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("denied"); } });
    assert.equal(lib.getSessionReferenceBudgetPercent(), 25);
    assert.doesNotThrow(() => lib.setSessionReferenceBudgetPercent(10));
  });
});

test("budget scales with model window and preference, without a fixed cap", () => {
  assert.equal(modelBudget().budgetTokens, 200);
  assert.equal(modelBudget({ percent: 100 }).budgetTokens, 800);
  const large = modelBudget({ providerModels: { p: [{ modelId: "m", contextWindow: 1_000_000 }] }, percent: 100 });
  assert.equal(large.budgetTokens, 800_000);
  const fallback = modelBudget({ providerModels: {} });
  assert.equal(fallback.contextWindow, 128_000);
  assert.equal(fallback.budgetTokens, 25_600);
  assert.equal(fallback.estimated, true);
});

test("target binding controls window/output reserve; old usage model cannot select its window", () => {
  const result = modelBudget({
    providerModels: { p: [{ modelId: "m", contextWindow: 2000 }, { modelId: "old", contextWindow: 1_000_000 }] },
    providers: [{ id: "p", models: [{ id: "vendor/m", contextWindow: 1000, maxTokens: 900 }] }],
    messages: [message("a", "assistant", "ok", { modelId: "old", providerId: "p", usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 30 } })],
  });
  assert.equal(result.contextWindow, 1000);
  assert.equal(result.outputReserve, 500);
  assert.equal(result.systemReserve, 100);
  assert.equal(result.usedTokens, 250);
  assert.equal(result.budgetTokens, 37);
});

test("budget reserves UTF-8/CJK input; zero headroom stays zero", () => {
  assert.equal(lib.estimateSessionReferenceTokens("汉字"), 2);
  const reserved = modelBudget({ currentInput: "汉字".repeat(200) });
  assert.ok(reserved.budgetTokens < modelBudget({ currentInput: "汉字" }).budgetTokens);
  assert.equal(modelBudget({ currentInput: "x".repeat(9000) }).budgetTokens, 0);
});

test("budget estimates only target visible text and includes compaction summary once", () => {
  const compactions = [{ id: "c", throughMessageId: "old", summaryTokens: 100, summarized: true, generation: 1 }];
  const before = message("old", "assistant", "x".repeat(9000), { usage: { inputTokens: 9000, outputTokens: 100 } });
  assert.equal(modelBudget({ messages: [before, message("new", "user", "汉字")], compactions }).usedTokens, 102);
  assert.equal(modelBudget({ messages: [before, message("new", "assistant", "ok", { usage: { inputTokens: 180, outputTokens: 20 } })], compactions }).usedTokens, 200);
  assert.equal(modelBudget({ messages: [message("nested", "assistant", "x".repeat(9000), { parentToolCallId: "tool" })] }).usedTokens, 0);
});

test("budget keeps reported occupancy when the compaction mark is outside the visible window", () => {
  const result = modelBudget({
    messages: [message("new", "assistant", "ok", { usage: { inputTokens: 800, outputTokens: 50, cacheReadTokens: 20 } })],
    compactions: [{ id: "c", throughMessageId: "missing", summaryTokens: 100, summarized: true, generation: 1 }],
  });
  assert.equal(result.usedTokens, 870);

  assert.equal(result.usageSource, "reported");
});


test("service walks physical >400-row pages without clipping tool or answer content", async () => {
  const messages = [message("u", "user", "Long tool-loop question"),
    ...Array.from({ length: 400 }, (_, i) => message(`t${i}`, "tool", "tool data")),
    message("a", "assistant", "Whole final answer")];
  const calls = [];
  resetHost({ getSession: async (id, options) => {
    calls.push([id, options]);
    assert.equal(options.messageLimit, 400);
    assert.equal(options.contentLimit, undefined);
    const end = options.messageBefore ?? messages.length;
    const start = Math.max(0, end - 400);
    return source(messages.slice(start, end), { messageStart: start, messageEnd: end, hasMoreBefore: start > 0 });
  } });
  const result = await lib.expandComposerSessionReferences(text, draft().fileReferences, targetId, { budgetTokens: 10000 });
  assert.deepEqual(calls.map(([, options]) => options.messageBefore), [undefined, 2]);
  assert.match(result.content, /Long tool-loop question/);
  assert.match(result.content, /Whole final answer/);
  assert.doesNotMatch(result.content, /tool data/);
  assert.equal(result.notices[0].includedTurns, 1);
});

test("service has no fixed ten-turn limit and refuses an oversized latest answer", async () => {
  resetHost({ getSession: async () => source(Array.from({ length: 12 }, (_, i) => [message(`u${i}`, "user", `Q${i}`), message(`a${i}`, "assistant", `A${i}`)]).flat()) });
  const complete = await lib.expandComposerSessionReferences(text, [], targetId, { budgetTokens: 10000 });
  assert.equal(complete.notices[0].includedTurns, 12);
  resetHost({ getSession: async () => source([message("u", "user", "Question"), message("a", "assistant", "x".repeat(10000))]) });
  const blocked = await lib.expandComposerSessionReferences(text, [], targetId, { budgetTokens: 100 });
  assert.equal(blocked.blockedReason, "budget");
  assert.equal(blocked.content, text);
});

test("service abort rejects a stalled IPC and ignores its late result", async () => {
  const page = deferred(); const controller = new AbortController(); let calls = 0;
  resetHost({ getSession: () => { calls++; return page.promise; } });
  const pending = lib.expandComposerSessionReferences(text, [], targetId, { budgetTokens: 10000, signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  page.resolve(source());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("service wall-time timeout rejects stalled IPC and removes external abort listener", async () => {
  resetHost({ getSession: () => new Promise(() => {}) });
  const original = globalThis.setTimeout;
  const controller = new AbortController(); let added = 0; let removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === lib.SESSION_REFERENCE_TIMEOUT_MS ? 0 : ms, ...args);
  try {
    await assert.rejects(lib.expandComposerSessionReferences(text, [], targetId, { budgetTokens: 10000, signal: controller.signal }), /timed out/);
  } finally { globalThis.setTimeout = original; }
  assert.equal(added, removed);
});

test("service refuses stale target bindings and malformed physical cursors", async () => {
  let current = true;
  resetHost({ getSession: async () => { current = false; return source(); } });
  await assert.rejects(lib.expandComposerSessionReferences(text, [], targetId, { budgetTokens: 10000, isCurrent: () => current }), /changed/);
  resetHost({ getSession: async () => source([message("a", "assistant", "orphan")], { hasMoreBefore: true, messageStart: -1 }) });
  await assert.rejects(lib.expandComposerSessionReferences(text, [], targetId, { budgetTokens: 10000 }));
});

function harness({ running = false, getSession = async () => source() } = {}) {
  const calls = []; const toasts = []; const optimistic = []; const entries = []; let reads = 0;
  resetHost({
    getSession: (...args) => { reads++; return getSession(...args); },
    prompt: async (request) => { calls.push(["prompt", request]); },
    steer: async (request) => { calls.push(["steer", request]); },
    queuePrompt: async (request) => { calls.push(["queue", request]); const entry = { ...request, id: "queued", createdAt: "2026-01-01" }; entries.push(entry); return entry; },
    listQueuedPrompts: async () => ({ entries }),
    prioritizeQueuedPrompt: async (id) => { calls.push(["prioritize", id]); },
    stop: async (id) => { calls.push(["stop", id]); },
    removeQueuedPrompt: async () => {},
  });

  const state = {
    activeSessionId: targetId, pendingPlans: {}, runningSessions: { [targetId]: running },
    agentStatuses: { [targetId]: { currentTurnId: "turn" } },
    sessions: [{ id: targetId, title: "Target", providerId: "p", modelId: "m" }, { id: otherId, title: "Other", providerId: "large", modelId: "large" }],
    messages: [], queuedPrompts: {}, latestTurnResults: {}, sessionOutcomes: {}, sessionCompactions: {}, retainedTranscripts: {},

    providers: [{ id: "p", models: [{ id: "m", contextWindow: 16000, maxTokens: 2000 }] }, { id: "large", models: [{ id: "large", contextWindow: 1000000 }] }],
    providerModels: {}, showToast: (...args) => toasts.push(args),
  };
  const runtime = {
    sessionTranscriptCache: new Map(), submittedComposerDrafts: new Map(),
    insertOptimisticUserMessage: (id, message) => optimistic.push([id, message]),
    retractOptimisticUserMessage: (id, message) => { const index = optimistic.findIndex(([, row]) => row === message); if (index >= 0) optimistic.splice(index, 1); },
    beginNavigationIntent: () => 1,
  };
  Object.assign(state, lib.createQueueSlice({
    get: () => state, set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update), runtime,
    promptAttachmentsFromDraft: (refs) => refs.filter((ref) => ref.kind !== "session"),
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    isDefaultSessionTitle: () => false, viewingSessionIdForPrompt: () => state.activeSessionId,
    messageErrorFromUnknown: (error) => ({ code: "TEST", message: error.message }),
    assistantErrorMessage: (error) => message("err", "assistant", error.message),
    materializeDraftSession: async () => targetId,
  }));
  return { state, runtime, calls, toasts, optimistic, entries, reads: () => reads };
}

for (const action of ["sendPrompt", "steerPrompt", "enqueuePrompt"]) {
  for (const failure of ["budget", "missing", "read-error"]) {
    test(`${action}: ${failure} keeps draft, with no optimistic row or host submission`, async () => {
      const h = harness({ running: action === "steerPrompt", getSession: async () => {
        if (failure === "read-error") throw Error("read failed");
        return failure === "missing" ? { session: null } : source([message("u", "user", "Q"), message("a", "assistant", "汉".repeat(20000))]);
      } });
      const input = draft(); const before = structuredClone(input);
      assert.equal(await h.state[action](text, input), false);
      assert.deepEqual(input, before);
      assert.equal(h.calls.length, 0);
      assert.equal(h.optimistic.length, 0);
      assert.deepEqual(h.state.queuedPrompts, {});
      assert.ok(h.toasts.some(([key]) => key.includes(failure === "budget" ? "sessionReferenceBudgetBlocked" : failure === "missing" ? "sessionReferenceMissing" : "sessionReferenceFailed")));
    });
  }
}

for (const change of ["model", "provider", "deleted", "plan", "steer-turn"]) {
  test(`submission refuses ${change} changes while reading and releases duplicate fence`, async () => {
    const page = deferred(); const h = harness({ running: change === "steer-turn", getSession: () => page.promise });
    const action = change === "steer-turn" ? "steerPrompt" : "sendPrompt";
    const pending = h.state[action](text, draft());
    assert.equal(await h.state[action](text, draft()), false);
    if (change === "model") h.state.sessions[0].modelId = "new";
    if (change === "provider") h.state.sessions[0].providerId = "new";
    if (change === "deleted") h.state.sessions = [];
    if (change === "plan") h.state.pendingPlans[targetId] = { status: "pending" };
    if (change === "steer-turn") h.state.agentStatuses[targetId].currentTurnId = "new-turn";
    page.resolve(source());
    assert.equal(await pending, false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.optimistic.length, 0);
  });
}

test("navigation alone does not redirect a captured target", async () => {
  const page = deferred(); const h = harness({ getSession: () => page.promise });
  const pending = h.state.sendPrompt(text, draft());
  h.state.activeSessionId = otherId;
  h.state.messages = [message("other", "assistant", "汉".repeat(20000))];
  page.resolve(source());
  assert.equal(await pending, true);
  assert.equal(h.calls[0][1].sessionId, targetId);
});

test("inactive target falls back to retained transcripts when the cache is empty", async () => {
  const h = harness(); h.state.activeSessionId = otherId;
  h.state.retainedTranscripts[targetId] = [message("used", "assistant", "ok", { usage: { inputTokens: 15500, outputTokens: 100 } })];
  assert.equal(await h.state.sendPrompt(text, draft(), targetId), false);
  assert.equal(h.calls.length, 0);
});

test("inactive target falls back to its cached transcript, not unrelated active messages", async () => {
  const h = harness(); h.state.activeSessionId = otherId;
  h.runtime.sessionTranscriptCache.set(targetId, [message("used", "assistant", "ok", { usage: { inputTokens: 15500, outputTokens: 100 } })]);
  assert.equal(await h.state.sendPrompt(text, draft(), targetId), false);
  assert.equal(h.calls.length, 0);
});

for (const action of ["sendPrompt", "steerPrompt", "enqueuePrompt"]) {
  test(`${action}: freezes once, preserves attachments, hides snapshots in visible text`, async () => {
    const h = harness({ running: action === "steerPrompt" });
    assert.equal(await h.state[action](text, draft()), true);
    assert.equal(h.reads(), 1);
    assert.match(h.calls[0][1].content, /Complete answer/);
    assert.equal(lib.stripSessionReferencePrompt(h.calls[0][1].content), text);
    assert.equal(h.calls[0][1].attachments[0].path, "notes.md");
    assert.ok(h.toasts.some(([key]) => key.startsWith("chat.sessionReferenceSummary")));
    for (const [, row] of h.optimistic) assert.equal(row.content, text);
  });
}

test("busy send queues a single frozen prompt; send-now never reads references again", async () => {
  const h = harness({ running: true });
  assert.equal(await h.state.sendPrompt(text, draft()), true);
  await h.state.refreshQueuedPrompts(targetId);
  const frozen = h.calls[0][1].content;
  await h.state.sendQueuedNow("queued");
  assert.equal(h.reads(), 1);
  assert.equal(h.entries[0].content, frozen);
  assert.deepEqual(h.calls.map(([kind]) => kind), ["queue", "prioritize", "stop"]);
});

test("rehydrated queue edit fallback strips hidden snapshots and keeps the queued payload frozen", async () => {
  const h = harness();
  assert.equal(await h.state.enqueuePrompt(text, draft()), true);
  const frozen = h.calls[0][1].content;
  // A separate factory has no renderer-only captured draft, just the durable payload.
  const rehydrated = harness();
  rehydrated.state.applyQueueChanged({ sessionId: targetId, entries: [{ id: "restored", sessionId: targetId, content: frozen, createdAt: "2026-01-01" }] });
  assert.equal(rehydrated.state.queuedPrompts[targetId][0].content, frozen);
  assert.equal(rehydrated.state.queuedPrompts[targetId][0].draft.text, text);
  rehydrated.state.editQueuedPrompt("restored");
  assert.equal(rehydrated.state.composerPrefill.text, text);
  assert.equal(rehydrated.reads(), 0);
});

test("no-reference send stays synchronous through host submission and never reads history", async () => {
  const h = harness();
  const pending = h.state.sendPrompt("plain", { text: "plain", fileReferences: [] });
  assert.equal(h.calls.length, 1);
  assert.equal(await pending, true);
  assert.equal(h.reads(), 0);
});
