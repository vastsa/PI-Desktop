import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const agent = await read("../electron/main/ipc/agent-ipc.ts");

const composer = await read("../src/components/Composer.tsx");
const transcript = await read("../src/stores/slices/transcript-slice.ts");
const events = await read("../src/stores/slices/events-slice.ts");
const sidecarDispatch = await read("../../../packages/agent-runtime/src/sidecar.ts");

test("native model readiness uses capability instead of Desktop secrets", () => {
  assert.match(composer, /const modelReady\s*=\s*nativeSession\s*\?\s*activeSessionSummary\??\.capabilities\?\.canPrompt === true\s*:/);
});

test("native abort bypasses smart-stop rewrite and refreshes source detail", () => {
  const abort = transcript.slice(transcript.indexOf("abort: async"));
  const native = abort.slice(abort.indexOf('source === "pi-native"'), abort.indexOf("const submittedDraft"));
  assert.match(native, /api\.abort\(sessionId\)/);
  assert.match(native, /api\.getSession/);
  assert.match(native, /return;/);
  assert.doesNotMatch(native, /replaceSessionMessages|resolveComposerSmartStop/);
});

test("native dispatch and events carry durable user acknowledgement", () => {
  const dispatch = sidecarDispatch.slice(sidecarDispatch.indexOf('case "agent.prompt"'), sidecarDispatch.indexOf('const turnId =', sidecarDispatch.indexOf('case "agent.prompt"')));
  assert.match(dispatch, /params\.userMessageId/);
  assert.match(events, /event\.type === "user_message_persisted"/);
  assert.match(events, /reconcilePersistedUserMessage/);
});

test("native compact and session-addressed queue endpoints reject before host or queue access", () => {
  for (const operation of ["agentCompact", "agentQueuePush", "agentQueueList"]) {
    const start = agent.indexOf(`handle(IPC.invoke.${operation},`);
    const body = agent.slice(start, agent.indexOf("\n  handle(", start + 1));
    assert.match(body, /rejectNativeAgentOperation\(req\.sessionId\)/, operation);
    const guard = body.indexOf("rejectNativeAgentOperation");
    for (const access of ["host.call", "agentHostBridge.", "resolveAgentRuntimeLaunch("]) {
      const at = body.indexOf(access);
      assert.ok(at < 0 || guard < at, `${operation} guards ${access}`);
    }
  }
  assert.match(agent, /errorCode: "NATIVE_PI_UNSUPPORTED"/);
});

// Real slices/IPC with synthetic state; no Electron process or native home.
const { register } = await import("node:module");
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { searchSessionsAcrossSources } = await import("../electron/main/services/session-search.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { api } = await import("../src/lib/api.ts");
const { mergeLiveSessionMessages, reconcilePersistedUserMessage } = await import("../src/lib/session-transcript.ts");

test("unsupported native agent IPC never reaches host or queue", async () => {
  const handlers = new Map();
  const forbidden = () => assert.fail("native operation reached Desktop backend");
  const backend = new Proxy({}, { get: () => forbidden });
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => backend, getSidecar: () => backend, getAgentHostBridge: () => backend,
  });
  for (const operation of ["agentCompact", "agentQueuePush", "agentQueueList"]) {
    await assert.rejects(handlers.get(IPC.invoke[operation])({ sessionId: "native-pi:fixture", content: "unused", itemId: "unused" }), { errorCode: "NATIVE_PI_UNSUPPORTED" });
  }
});

const user = (id) => ({ id, role: "user", content: "identical prompt", createdAt: "2026-09-14T00:00:00Z", status: "complete" });
function stateHarness(state) {
  return { get: () => state, set: (update) => { Object.assign(state, typeof update === "function" ? update(state) : update); } };
}

test("durable user acknowledgement reconciles active, cached and background rows across reselects", () => {
  for (const activeSessionId of ["native-pi:fixture", "desktop-session"]) {
    const id = "native-pi:fixture";
    const state = { activeSessionId, messages: [user("optimistic-1"), user("optimistic-2")], retainedTranscripts: { [id]: [user("optimistic-1"), user("optimistic-2")] } };
    const runtime = {
      liveSessionTranscripts: new Set(), sessionTranscriptCache: new Map([[id, [...state.messages]]]),
      cacheSessionTranscript: (key, rows) => runtime.sessionTranscriptCache.set(key, rows),
    };
    const slice = createEventsSlice({ ...stateHarness(state), runtime });
    for (const index of [1, 2]) {
      const event = { type: "user_message_persisted", optimisticMessageId: `optimistic-${index}`, message: user(`durable-${index}`) };
      slice.handleAgentEvent({ sessionId: id, ts: 1, event });
      slice.handleAgentEvent({ sessionId: id, ts: 2, event });
    }
    const durable = [user("durable-1"), user("durable-2")];
    assert.deepEqual(runtime.sessionTranscriptCache.get(id), durable);
    assert.deepEqual(state.retainedTranscripts[id], durable);
    if (activeSessionId === id) assert.deepEqual(state.messages, durable);
    let rows = state.retainedTranscripts[id];
    for (let refresh = 0; refresh < 3; refresh++) rows = mergeLiveSessionMessages(durable, rows);
    assert.deepEqual(rows, durable);
    assert.deepEqual(reconcilePersistedUserMessage([user("optimistic-1"), user("durable-1")], "optimistic-1", user("durable-1")), [user("durable-1")]);
  }
});

test("native smart-stop abort keeps one durable user row and never rewrites the source", async () => {
  const id = "native-pi:fixture";
  const state = { activeSessionId: id, sessions: [{ id, source: "pi-native" }], messages: [user("optimistic-1")], retainedTranscripts: {}, runningSessions: { [id]: true }, isRunning: true };
  const calls = [];
  const originalAbort = api.abort;
  const originalReplace = api.replaceSessionMessages;
  const originalGet = api.getSession;
  api.getSession = async () => { calls.push("detail"); return { session: { messages: [user("durable-1")] } }; };
  api.abort = async (sessionId) => { calls.push("abort"); assert.equal(sessionId, id); };
  api.replaceSessionMessages = async () => assert.fail("native abort must not rewrite transcript");
  const runtime = {
    submittedComposerDrafts: new Map([[id, { messageCountBeforeSend: 0, draft: { text: "identical prompt", fileReferences: [] } }]]),
    cacheSessionTranscript: (_id, rows) => { runtime.cached = rows; },
  };
  try {
    await createTranscriptSlice({ ...stateHarness(state), runtime }).abort();
    assert.equal(calls[0], "abort");
    assert.deepEqual(state.messages, [user("durable-1")]);
    assert.deepEqual(runtime.cached, state.messages);
    assert.equal(state.isRunning, false);
    assert.equal(runtime.submittedComposerDrafts.size, 0);
  } finally { api.abort = originalAbort; api.replaceSessionMessages = originalReplace; api.getSession = originalGet; }
});


test("queue remove/prioritize preserve the Desktop opaque host turnId contract", async () => {
  const handlers = new Map();
  const calls = [];
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => null, getSidecar: () => null,
    getAgentHostBridge: () => ({ queue: {
      remove: async (turnId) => calls.push(["remove", turnId]),
      prioritize: async (turnId) => calls.push(["prioritize", turnId]),
    } }),
  });
  await handlers.get(IPC.invoke.agentQueueRemove)({ turnId: "host-turn" });
  await handlers.get(IPC.invoke.agentQueuePrioritize)({ turnId: "host-turn" });
  assert.deepEqual(calls, [["remove", "host-turn"], ["prioritize", "host-turn"]]);
});

test("native prompt only dispatches sidecar and cannot create a host queue entry", async () => {
  const handlers = new Map();
  const forbidden = () => assert.fail("native prompt reached Desktop host/queue");
  const backend = new Proxy({}, { get: () => forbidden });
  const calls = [];
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => backend, getAgentHostBridge: () => backend, setNotificationViewingSessionId() {},
    getSidecar: () => ({ call: async (...args) => { calls.push(args); return { accepted: true, turnId: "native-turn" }; } }),
  });
  await handlers.get(IPC.invoke.agentPrompt)({ sessionId: "native-pi:fixture", content: "prompt", messageId: "optimistic" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "agent.prompt");
  assert.equal(calls[0][1].userMessageId, "optimistic");
});


test("native model readiness never depends on a Desktop provider but read-only fails closed", () => {
  const expression = composer.match(/const modelReady = ([\s\S]*?);/)[1];
  const ready = new Function("nativeSession", "activeSessionSummary", "provider", "modelId", `return ${expression}`);
  assert.equal(ready(true, { capabilities: { canPrompt: true } }, undefined, undefined), true);
  assert.equal(ready(true, { capabilities: { canPrompt: false } }, { enabled: true, hasSecret: true }, "model"), false);
  assert.equal(ready(true, {}, undefined, undefined), false);
  assert.equal(ready(false, {}, undefined, undefined), false);
  assert.equal(ready(false, {}, { enabled: true, hasSecret: false }, "model"), false);
  assert.equal(ready(false, {}, { enabled: true, hasSecret: true }, "model"), true);
});


test("unknown or delayed durable acknowledgements never insert a duplicate renderer row", () => {
  const rows = [user("durable")];
  assert.strictEqual(reconcilePersistedUserMessage(rows, "already-reconciled", user("durable")), rows);
  assert.strictEqual(reconcilePersistedUserMessage(rows, "unknown", user("new-id")), rows);
});


const { default: ts } = await import("typescript");
const sharedForIpc = await import("@pi-desktop/shared");
const { readFileSync } = await import("node:fs");
const nodePath = await import("node:path");

/**
 * Load main-process TypeScript with injected CommonJS dependencies, matching
 * the existing session IPC test harness.
 */
function loadSessionIpc(imports) {
  const file = new URL("../electron/main/ipc/session-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

function forkHarness({ host, sidecar }) {
  const handlers = new Map();
  const hostCalls = [];
  const sidecarCalls = [];
  const { registerSessionIpc } = loadSessionIpc({
    electron: { shell: {} },
    "node:path": nodePath,
    "node:fs": { mkdirSync() {} },
    "@pi-desktop/shared": sharedForIpc,
    "../importers": { convertSession() {}, scanAllSources() {}, scanModelConfigs() {} },
    "../services/session-collaboration": { readSessionCollaboration() {} },
    "../services/session-search": { searchSessionsAcrossSources },
  });
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host(hostCalls),
    getSidecar: () => sidecar(sidecarCalls),
    dataDir: "/tmp/pi-desktop-test",
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: {},
    logger: { app() {} },
    plugins: { broadcastEvent() {} },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (session) => session,
    acquireSessionOperation: async () => () => {},
    stripWinLongPrefix: (value) => value,
  });
  return {
    handle: handlers.get(IPC.invoke.sessionFork),
    search: handlers.get(IPC.invoke.sessionSearch),
    hostCalls,
    sidecarCalls,
  };
}

const searchSession = (id, updatedAt) => ({
  session: { id, title: id, updatedAt, source: id.startsWith("native") ? "pi-native" : "desktop" },
  projectName: null,
  metadataMatch: true,
  messageCount: 0,
  matches: [],
});

test("global session search merges native sidecar hits with Desktop results", async () => {
  const nativeHit = searchSession("native-pi:child", "2026-09-14T00:00:02.000Z");
  const desktopHit = searchSession("desktop-session", "2026-09-14T00:00:01.000Z");
  const { search, hostCalls, sidecarCalls } = forkHarness({
    host: (calls) => ({
      call: async (method, input) => {
        calls.push({ method, input });
        return { hits: [desktopHit], nextOffset: null };
      },
    }),
    sidecar: (calls) => ({
      call: async (method, input) => {
        calls.push({ method, input });
        return { hits: [nativeHit], nextOffset: null };
      },
    }),
  });
  const result = await search({ query: "side chat", offset: 0 });
  assert.deepEqual(result.hits.map((hit) => hit.session.id), ["native-pi:child", "desktop-session"]);
  assert.deepEqual(sidecarCalls, [{ method: "native.session.search", input: { query: "side chat" } }]);
  assert.deepEqual(hostCalls, [{ method: "search.sessions", input: { query: "side chat", offset: 0 } }]);
});

test("native fork routes to the sidecar and never to the Desktop host", async () => {
  const { handle, hostCalls, sidecarCalls } = forkHarness({
    host: () => ({ call: () => { throw new Error("native fork must not call the host"); } }),
    sidecar: (calls) => ({
      call: async (method, input) => {
        calls.push({ method, input });
        return { session: { id: "native-pi:child", title: "Side chat" } };
      },
    }),
  });
  const result = await handle({
    sessionId: " native-pi:parent ",
    title: " Side  chat ",
    throughMessageId: " a1 ",
  });
  assert.equal(result.session.id, "native-pi:child");
  assert.deepEqual(sidecarCalls, [{
    method: "native.session.fork",
    input: { id: "native-pi:parent", title: "Side chat", throughMessageId: "a1" },
  }]);
  assert.deepEqual(hostCalls, []);
});

test("native fork rejects an oversized anchor before calling the sidecar", async () => {
  const { handle, sidecarCalls } = forkHarness({
    host: () => ({ call: () => { throw new Error("native fork must not call the host"); } }),
    sidecar: (calls) => ({ call: async (method, input) => { calls.push({ method, input }); } }),
  });
  await assert.rejects(handle({ sessionId: "native-pi:parent", throughMessageId: "x".repeat(257) }), {
    errorCode: "INVALID_ARGUMENT",
  });
  assert.deepEqual(sidecarCalls, []);
});

test("desktop session fork keeps the existing host contract", async () => {
  const { handle, hostCalls } = forkHarness({
    host: (calls) => ({
      call: async (method, input) => {
        calls.push({ method, input });
        return { session: { id: "desktop-child", title: "Child" } };
      },
    }),
    sidecar: () => ({ call: () => { throw new Error("desktop fork must not call the sidecar"); } }),
  });
  const result = await handle({ sessionId: "desktop-parent", title: "Child", throughMessageId: "m1" });
  assert.equal(result.session.id, "desktop-child");
  assert.deepEqual(hostCalls, [{
    method: "session.fork",
    input: { sessionId: "desktop-parent", title: "Child", throughMessageId: "m1" },
  }]);
});

const assistantRow = (id, status, content = "part") => ({
  id,
  role: "assistant",
  content,
  createdAt: "2026-09-14T00:00:00Z",
  status,
});

test("native terminal events re-key exactly the provisional row they name", async () => {
  const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
  const id = "native-pi:child";
  const provisional = assistantRow("stream-1", "streaming", "partial");
  const otherStream = assistantRow("stream-2", "streaming", "delegate answer");
  const durable = assistantRow("entry-1", "complete", "fixture reply");
  const state = {
    activeSessionId: id,
    messages: [provisional, otherStream],
    retainedTranscripts: { [id]: [provisional, otherStream] },
    runningSessions: { [id]: true },
    isRunning: true,
  };
  const runtime = createSessionRuntime({
    get: () => state,
    set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update),
  });
  const slice = createEventsSlice({ ...stateHarness(state), runtime });
  // Warm the same cache the app uses when a session was loaded or forked.
  runtime.cacheSessionTranscript(id, [provisional, otherStream]);
  slice.handleAgentEvent({
    sessionId: id,
    ts: 5,
    event: { type: "message_end", message: durable, replacesMessageId: "stream-1" },
  });
  for (const rows of [
    state.messages,
    state.retainedTranscripts[id],
    runtime.sessionTranscriptCache.get(id),
  ]) {
    assert.deepEqual(rows.map((row) => row.id), ["stream-2", "entry-1"], JSON.stringify(rows.map((row) => row.id)));
  }
});

test("a duplicate historical completion keeps an unrelated live stream", async () => {
  const { projectMessageEnd } = await import("../src/lib/session-transcript.ts");
  const historical = assistantRow("old-answer", "complete", "old reply");
  const live = assistantRow("stream-new-turn", "streaming", "new reply");
  const settled = projectMessageEnd([historical, live], { type: "message_end", message: historical });
  assert.deepEqual(settled.map((row) => row.id), ["old-answer", "stream-new-turn"]);
  // The exact native correlation only touches the named provisional row.
  const nativeSettled = projectMessageEnd([historical, live], {
    type: "message_end",
    message: assistantRow("new-durable", "complete", "new reply"),
    replacesMessageId: "stream-new-turn",
  });
  assert.deepEqual(nativeSettled.map((row) => row.id), ["old-answer", "new-durable"]);
  // An empty failed terminal removes the provisional row and leaves nothing.
  const aborted = projectMessageEnd([historical, live], {
    type: "message_end",
    message: assistantRow("new-durable", "aborted", ""),
    replacesMessageId: "stream-new-turn",
  });
  assert.deepEqual(aborted.map((row) => row.id), ["old-answer"]);
  // Replaying the same durable completion is idempotent.
  const replayed = projectMessageEnd(nativeSettled, {
    type: "message_end",
    message: assistantRow("new-durable", "complete", "new reply"),
    replacesMessageId: "stream-new-turn",
  });
  assert.deepEqual(replayed.map((row) => row.id), ["old-answer", "new-durable"]);
});

test("a generic Desktop completion never touches parallel delegate streams", async () => {
  const { projectMessageEnd } = await import("../src/lib/session-transcript.ts");
  const delegateA = assistantRow("delegate-a", "streaming", "A");
  const delegateB = assistantRow("delegate-b", "streaming", "B");
  const settledA = assistantRow("delegate-a", "complete", "A done");
  const settled = projectMessageEnd([delegateA, delegateB], { type: "message_end", message: settledA });
  assert.deepEqual(settled.map((row) => row.id), ["delegate-a", "delegate-b"]);
  assert.equal(settled[1].status, "streaming");
});

const queueSlice = await read("../src/stores/slices/queue-slice.ts");

test("a running native side-chat send fails before the Desktop queue", () => {
  const guard = queueSlice.slice(
    queueSlice.indexOf("?.source ==="),
    queueSlice.indexOf("const accepted = await get().enqueuePrompt"),
  );
  assert.match(guard, /"pi-native"/);
  assert.match(guard, /showToast\(i18n\.t\("chat\.nativeSessionBusy"\)/);
  assert.match(guard, /return false/);
});

test("the native busy message is localized in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW", "de", "ko", "fr", "es", "tr"]) {
    const source = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    assert.match(source, /nativeSessionBusy:/, locale);
  }
});
