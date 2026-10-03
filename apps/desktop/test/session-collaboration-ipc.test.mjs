import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}

const shared = { ErrorCodes, IPC, IPC_WHITELIST };
const collaboration = load("../electron/main/services/session-collaboration.ts", {
  "node:crypto": crypto,
  "../agent-host-bridge": {},
  "../plugin-agent-complete": {},
});
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": shared,
  "../importers": {},
  "../services/session-collaboration": collaboration,
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
  "../pending-asks": { pendingAsksRegistry: { clearSession() {} } },
});
const summary = {
  sessionId: "worker-session-id",
  title: "Review",
  status: "running",
  observedAt: "2026-09-13T12:00:00.000Z",
  recentExchanges: [],
};

function harness(read = async () => summary, sidecar = null) {
  const handlers = new Map();
  const calls = [];
  let host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return read(method, input);
    },
  };
  const unexpected = () => assert.fail("summary reads must not load or mutate session state");
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => sidecar,
    sessionCapabilityContext: unexpected,
    enrichSession: unexpected,
    acquireSessionOperation: unexpected,
    plugins: { broadcastEvent: unexpected },
    persistenceOutbox: { dropSession: unexpected },
    logger: { app: unexpected },
    activeTurns: new Map(),
    sessionProjects: new Map(),
  });
  const handle = handlers.get(IPC.invoke.sessionCollaboration);
  assert.equal(typeof handle, "function");
  return { handle, calls, clearHost: () => { host = null; } };
}

function rendererApi(invoke) {
  let bridge;
  load("../electron/preload/index.ts", {
    electron: {
      contextBridge: { exposeInMainWorld: (name, value) => {
        assert.equal(name, "piDesktop");
        bridge = value;
      } },
      ipcRenderer: { invoke },
      webUtils: {},
    },
    "@pi-desktop/shared": shared,
    "@pi-desktop/shared/protocol": shared,
  });
  const { api } = load("../src/lib/api.ts", { "@pi-desktop/shared": shared }, {
    window: { piDesktop: bridge },
  });
  return { api, bridge };
}

test("the renderer reaches only the summary RPC through the allowed preload channel", async () => {
  const { handle, calls } = harness();
  const { api, bridge } = rendererApi(async (channel, ...args) => {
    assert.equal(channel, IPC.invoke.sessionCollaboration);
    return { ok: true, data: await handle(...args) };
  });
  assert.equal(IPC_WHITELIST.has(IPC.invoke.sessionCollaboration), true);
  assert.equal(bridge.channels.invoke.sessionCollaboration, IPC.invoke.sessionCollaboration);
  assert.equal(await api.getSessionCollaboration("worker-session-id"), summary);
  assert.deepEqual(calls, [{
    method: "session.collaboration.status",
    input: { sessionId: "worker-session-id" },
  }]);
});

test("the summary handler rejects missing, non-string and oversized session IDs", async () => {
  const { handle, calls } = harness();
  const inputs = [
    undefined, null, {}, "worker-session-id", { sessionId: null },
    { sessionId: 42 }, { sessionId: ["worker-session-id"] },
    { sessionId: "" }, { sessionId: " \n\t " }, { sessionId: "s".repeat(257) },
  ];
  for (const input of inputs) {
    await assert.rejects(handle(input), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  assert.deepEqual(calls, []);
});

test("the handler normalizes the ID and never forwards unrelated caller fields", async () => {
  const { handle, calls } = harness();
  await handle({ sessionId: " worker-session-id ", activate: true, messageLimit: 1000 });
  assert.deepEqual(calls, [{
    method: "session.collaboration.status",
    input: { sessionId: "worker-session-id" },
  }]);
});

test("host disappearance fails without reusing an earlier summary", async () => {
  const { handle, calls, clearHost } = harness();
  assert.equal(await handle({ sessionId: summary.sessionId }), summary);
  clearHost();
  await assert.rejects(handle({ sessionId: summary.sessionId }), /host unavailable/);
  assert.equal(calls.length, 1);
});

test("missing sessions preserve the host's error instead of returning idle", async () => {
  const missing = Object.assign(new Error("Session not found"), {
    data: { errorCode: ErrorCodes.NOT_FOUND },
  });
  const { handle } = harness(async () => { throw missing; });
  await assert.rejects(handle({ sessionId: "deleted-session-id" }), (error) => error === missing);
});

test("live activity overlays durable outcomes without losing provenance", async () => {
  const stored = { ...summary, status: "completed", createdBySession: { sessionId: "parent", title: "Parent" } };
  for (const pendingToolConfirmations of [0, 1]) {
    const calls = [];
    const { handle } = harness(async () => stored, {
      call: async (method, input) => {
        calls.push({ method, input });
        return { status: { sessionId: summary.sessionId, isRunning: true, pendingToolConfirmations } };
      },
    });
    const next = await handle({ sessionId: summary.sessionId });
    assert.equal(next.status, pendingToolConfirmations ? "waiting_permission" : "running");
    assert.deepEqual(next.createdBySession, stored.createdBySession);
    assert.ok(Number.isFinite(Date.parse(next.observedAt)));
    assert.deepEqual(calls, [{ method: "agent.getStatus", input: { sessionId: summary.sessionId } }]);
  }
});

test("idle or unrelated live activity cannot replace the durable status", async () => {
  const stored = { ...summary, status: "interrupted" };
  for (const status of [
    { sessionId: summary.sessionId, isRunning: false, pendingToolConfirmations: 0 },
    { sessionId: "other-session", isRunning: true, pendingToolConfirmations: 1 },
  ]) {
    const { handle } = harness(async () => stored, { call: async () => ({ status }) });
    assert.equal(await handle({ sessionId: summary.sessionId }), stored);
  }
});

test("live read failures remain unavailable instead of pretending a stored result is current", async () => {
  const unavailable = new Error("Agent runtime restarted");
  const { handle } = harness(async () => ({ ...summary, status: "completed" }), {
    call: async () => { throw unavailable; },
  });
  await assert.rejects(handle({ sessionId: summary.sessionId }), (error) => error === unavailable);
});

test("the renderer preserves failed Result codes and details", async () => {
  const { api } = rendererApi(async () => ({
    ok: false,
    error: { code: ErrorCodes.NOT_FOUND, message: "Session not found", details: { sessionId: "deleted" } },
  }));
  await assert.rejects(api.getSessionCollaboration("deleted"), {
    message: "Session not found",
    code: ErrorCodes.NOT_FOUND,
    details: { sessionId: "deleted" },
  });
});

test("adding a summary read does not expose arbitrary preload channels", async () => {
  let calls = 0;
  const { bridge } = rendererApi(async () => { calls += 1; });
  await assert.rejects(bridge.invoke("session.collaboration.status", { sessionId: summary.sessionId }), /IPC channel not allowed/);
  assert.equal(calls, 0);
});
