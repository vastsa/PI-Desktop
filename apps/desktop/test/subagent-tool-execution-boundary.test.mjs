import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../../../packages/host-runtime/src/agent-sidecar.ts");
const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { wireChildExecutionLifecycle } = await import("../electron/main/runtime/child-execution-lifecycle.ts");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const owner = { sessionId: "session", turnId: "parent", runtimeId: "runtime", executionOwnerId: "child-execution" };
const tool = (id, extra = {}) => ({ sessionId: "session", turnId: "parent", toolCallId: id,
  toolName: "plugin_demo_echo", mode: "agent", args: {}, ...extra });

async function fixture(t, execute = async () => "done") {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const q = JSON.parse(line);
        if (q.method === 'host.notification') return;
        if (q.method) console.log(JSON.stringify({ id: q.id, method: 'host.proxy', params: q.params }));
        else console.log(JSON.stringify(q));
      });`] }, onStderr() {},
  });
  t.after(() => sidecar.dispose());
  const pending = new Map();
  const listeners = new Set();
  const exits = new Set();
  const forwarded = [];
  const calls = [];
  const events = [];
  const host = {
    onNotification(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
    async call(method, params) {
      forwarded.push({ method, params });
      if (method === "tools.execute") {
        const reply = deferred();
        pending.set(params.toolCallId, reply);
        const { executionOwnerId, runtimeId, ...notification } = params;
        for (const fn of listeners) fn("plugins.execute", { ...notification, executionId: params.toolCallId });
        return reply.promise;
      }
      if (method === "plugins.resolveExecution") {
        pending.get(params.executionId)?.resolve(params);
        pending.delete(params.executionId);
      }
      return {};
    },
  };
  const state = { host, sidecar, agentHostBridge: null };
  const activeTurns = new Map([["session", "parent"]]);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  createHostRuntime({ runtimeState: state, dataDir: "unused", logger: { app() {}, flushChild() {} },
    persistenceOutbox: { size: () => 0, flush: async () => {} }, activeToolCalls: new Map(),
    activeToolCallKey: (s, c) => `${s}:${c}`, sessionProjects: new Map(),
    plugins: { getTools: () => [{ fullName: "plugin_demo_echo", pluginId: "demo", execute: async (args, ctx) => {
      calls.push(ctx); return execute(ctx);
    } }], drainToasts: () => [] },
    userMcp: { callTool: async (_name, _args, _project, _session, signal) => { calls.push({ signal }); return execute({ signal }); } },
    pluginActiveInProject: () => true, sendToRenderer() {}, emitAgentEvent() {}, togglePluginLauncher: async () => {},
    finishTurn: async () => {}, isTurnDispatchable: coordination.isTurnDispatchable, finishApprovedExecution: async () => {},
    activeTurns, approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    importLegacyScheduled: async () => {}, superviseRestart: async () => {}, isQuitting: () => false,
    ensureSystemProxyRelay: async () => "unused",
    currentNetworkDns: () => ({ mode: "system" }),
  }).wireHost(host);
  wireChildExecutionLifecycle(sidecar, { isCurrent: () => state.sidecar === sidecar,
    isTurnDispatchable: coordination.isTurnDispatchable, sessionProjects: new Map(), pluginActiveInProject: () => true,
    plugins: { broadcastEvent: (name, args, filter) => events.push({ name, args, demo: filter("demo"), unrelated: filter("other") }) },
  });
  sidecar.setHost(host);
  return { sidecar, state, host, activeTurns, coordination, calls, forwarded, events,
    proxy: (method, params) => sidecar.call("probe", { method, params }),
  };
}

test("registered child tools run after parent finalization and keep an independent plugin lifetime", async t => {
  const f = await fixture(t);
  await f.proxy("tools.execution.start", owner);
  f.activeTurns.delete("session");
  const result = await f.proxy("tools.execute", tool("child-call", owner));
  assert.equal(result.ok, true);
  assert.equal(f.calls[0].turnId, owner.executionOwnerId);
  assert.notEqual(f.calls[0].turnId, owner.turnId);
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.forwarded.some(q => q.method === "tools.execution.start"), false, "ownership stays in the trusted sidecar bridge");
  await f.proxy("tools.execution.end", { ...owner, reason: "completed" });
  assert.deepEqual(f.events.map(event => [event.name, event.args[0].turnId, event.demo, event.unrelated]), [
    ["subagent:executionEnded", owner.executionOwnerId, true, false],
    ["session:turnEnded", owner.executionOwnerId, true, false],
  ]);
  await assert.rejects(f.proxy("tools.execute", tool("late-child", owner)));
});

test("a new parent cannot lend its turn to a child or resurrect a revoked owner", async t => {
  const f = await fixture(t);
  await f.proxy("tools.execution.start", owner);
  f.activeTurns.set("session", "new-parent");
  for (const overrides of [{ executionOwnerId: "forged" }, { sessionId: "other" },
    { runtimeId: "replacement" }, { turnId: "new-parent" }]) {
    await assert.rejects(f.proxy("tools.execute", tool("rejected", { ...owner, ...overrides })));
  }
  const missing = await f.proxy("tools.execute", tool("missing-owner"));
  assert.equal(missing.ok, false);
  assert.equal(f.calls.length, 0);
});

for (const toolName of ["plugin_demo_echo", "mcp_demo_echo"]) {
  test(`${toolName}: exact-call abort isolates parent and child in one session`, async t => {
    const ready = deferred();
    const releases = new Map();
    const f = await fixture(t, ctx => {
      const release = deferred();
      releases.set(ctx.signal, release);
      ctx.signal?.addEventListener("abort", () => release.resolve("cancelled"), { once: true });
      if (releases.size === 2) ready.resolve();
      return release.promise;
    });
    t.after(() => { for (const release of releases.values()) release.resolve("cleanup"); });
    await f.proxy("tools.execution.start", owner);
    const parent = f.proxy("tools.execute", tool("parent-call", { toolName }));
    const child = f.proxy("tools.execute", tool("child-call", { ...owner, toolName }));
    await ready.promise;
    await f.proxy("tools.abort", { sessionId: "session", toolCallId: "parent-call" });
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[1].signal.aborted, false);
    await parent;
    await f.proxy("tools.execution.end", { ...owner, reason: "aborted" });
    assert.equal(f.calls[1].signal.aborted, true);
    await child;
  });
}

test("abort before dispatch cannot start a plugin side effect", async t => {
  const f = await fixture(t);
  await f.proxy("tools.abort", { sessionId: "session", toolCallId: "cancelled" });
  await assert.rejects(f.proxy("tools.execute", tool("cancelled")));
  assert.equal(f.calls.length, 0);
});

test("host replacement revokes child authority and cancels its in-flight call", async t => {
  const ready = deferred();
  const release = deferred();
  const f = await fixture(t, ctx => {
    ctx.signal?.addEventListener("abort", () => release.resolve("cancelled"), { once: true });
    ready.resolve(); return release.promise;
  });
  t.after(() => release.resolve("cleanup"));
  await f.proxy("tools.execution.start", owner);
  const child = f.proxy("tools.execute", tool("child-call", owner));
  await ready.promise;
  f.sidecar.setHost({ ...f.host });
  assert.equal(f.calls[0].signal.aborted, true);
  await child;
  await assert.rejects(f.proxy("tools.execute", tool("stale-generation", owner)));
});

test("an owner cannot register after the parent stop lock", async t => {
  const f = await fixture(t);
  f.coordination.lockAbortReason("session", "parent");
  await assert.rejects(f.proxy("tools.execution.start", owner));
  assert.equal(f.calls.length, 0);
});

test("a retired owner cannot be registered again while its original parent is still live", async t => {
  const f = await fixture(t);
  await f.proxy("tools.execution.start", owner);
  await f.proxy("tools.execution.end", { ...owner, reason: "completed" });
  await assert.rejects(f.proxy("tools.execution.start", owner));
});

test("child cancellation during session lookup prevents plugin dispatch", async t => {
  const f = await fixture(t);
  await f.proxy("tools.execution.start", owner);
  const read = deferred();
  const reading = deferred();
  const call = f.host.call.bind(f.host);
  f.host.call = async (method, params) => {
    if (method === "session.get") { reading.resolve(); return read.promise; }
    return call(method, params);
  };
  const pending = f.proxy("tools.execute", tool("blocked", { ...owner, mode: undefined }));
  await reading.promise;
  await f.proxy("tools.execution.end", { ...owner, reason: "aborted" });
  read.resolve({ session: { mode: "agent" } });
  assert.equal((await pending).ok, false);
  assert.equal(f.calls.length, 0);
});
