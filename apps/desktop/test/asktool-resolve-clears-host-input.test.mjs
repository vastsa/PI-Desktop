import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));

const askRequest = {
  requestId: "ask_1",
  sessionId: "s1",
  toolCallId: "c9",
  questions: [
    {
      question: "Which?",
      options: [
        { label: "a", description: "First choice" },
        { label: "b", description: "Second choice" },
      ],
    },
  ],
};

function ingestAsk(bridge) {
  bridge.ingest({ sessionId: "s1", turnId: "rt_1", ts: Date.now(), event: { type: "agent_start" } });
  bridge.ingest({
    sessionId: "s1",
    turnId: "rt_1",
    ts: Date.now(),
    event: { type: "asktool_request", request: askRequest },
  });
}

test("resolveAskByRequestId settles the Host input so the card does not come back", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const calls = [];
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => null,
    log: () => undefined,
    async invoke(channel, args) {
      calls.push({ channel, args });
      return { ok: true };
    },
  });

  ingestAsk(bridge);
  assert.equal((await bridge.pendingInteractiveRequests("s1")).asks.length, 1);

  const settled = await bridge.resolveAskByRequestId({
    sessionId: "s1",
    requestId: "ask_1",
    answers: [["a"]],
  });
  assert.deepEqual(settled, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, IPC.invoke.askToolResolve);
  assert.equal(calls[0].args[0].requestId, "ask_1");
  assert.deepEqual(calls[0].args[0].answers, [["a"]]);
  assert.deepEqual((await bridge.pendingInteractiveRequests("s1")).asks, []);
});

test("resolveAskByRequestId returns null for unknown requests", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  let invoked = 0;
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => null,
    log: () => undefined,
    async invoke() {
      invoked += 1;
      return { ok: true };
    },
  });

  assert.equal(
    await bridge.resolveAskByRequestId({ sessionId: "s1", requestId: "missing", answers: [null] }),
    null,
  );
  assert.equal(
    await bridge.resolveAskByRequestId({ sessionId: "", requestId: "ask_1", answers: [null] }),
    null,
  );
  assert.equal(invoked, 0);
});

/**
 * The Host answers an open input by calling back through this same registered
 * handler: the bridge's runtime port wraps the `invokeIpc` dispatcher, so
 * `resolveAskByRequestId` runs a second time while the outer frame still holds
 * the pending input (it is deleted only after `respondInput` returns). Without
 * the bridge's in-flight guard those two frames re-enter each other until the
 * stack overflows — the answer never reaches the runtime, `pendingInputs` is
 * never cleared, and the answered card comes back on the next session switch.
 * The mocked `invoke` above cannot see that wiring, so this test assembles the
 * real handler.
 */
test("a Host-owned answer does not re-enter its own IPC handler", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const { registerAgentIpc } = await server.ssrLoadModule("/electron/main/ipc/agent-ipc.ts");

  // The handler table `invokeIpc` dispatches into (register.ts:502).
  const handlers = new Map();
  const registrar = {
    ipcMain: { handle() {} },
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    handleWithEvent(channel, handler) {
      handlers.set(channel, handler);
    },
    assertMainWindowSender() {},
  };
  const invoke = async (channel, args = []) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`handler not registered: ${channel}`);
    return handler(...args);
  };

  const sidecarCalls = [];
  const sidecar = {
    async call(method, params) {
      sidecarCalls.push({ method, params });
      return { ok: true };
    },
  };
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    invoke,
    getHost: () => null,
    log: () => undefined,
  });

  const noop = () => undefined;
  registerAgentIpc({
    registrar,
    getHost: () => null,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => bridge,
    logger: { app: noop },
    vendorOAuth: {},
    agentExtensions: {},
    cancelSessionTools: noop,
    persistenceOutbox: {},
    dataDir: "",
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({}),
    acquireSessionOperation: async () => noop,
    finishTurn: async () => undefined,
    lockAbortReason: noop,
    finishApprovedExecution: async () => undefined,
    dispatchApprovedPlan: async () => undefined,
    dispatchExecutionForProposal: async () => undefined,
    emitAgentEvent: noop,
    setNotificationViewingSessionId: noop,
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
  });

  ingestAsk(bridge);
  assert.equal((await bridge.pendingInteractiveRequests("s1")).asks.length, 1);

  const settled = await handlers.get(IPC.invoke.askToolResolve)({
    sessionId: "s1",
    requestId: "ask_1",
    answers: [["a"]],
  });

  assert.deepEqual(settled, { ok: true });
  // The answer reaches the runtime exactly once, through the re-entrant frame's
  // fallback, and the Host stops reporting the input afterwards.
  assert.equal(sidecarCalls.length, 1);
  assert.equal(sidecarCalls[0].method, "asktool.resolve");
  assert.equal(sidecarCalls[0].params.requestId, "ask_1");
  assert.deepEqual(sidecarCalls[0].params.answers, [["a"]]);
  assert.deepEqual((await bridge.pendingInteractiveRequests("s1")).asks, []);
});
