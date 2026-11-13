import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../../../packages/host-runtime/src/agent-sidecar.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { wireChildExecutionLifecycle } = await import("../electron/main/runtime/child-execution-lifecycle.ts");
const { PluginToolInvocations } = await import("../electron/main/plugin-tool-invocations.ts");
const { IPC } = await import("../../../packages/shared/dist/index.js");

const reply = (res, delta, finish = "stop") => {
  const chunk = (d, f) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
    model: "fixture-model", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n");
};
const toolReply = (res, id, name, args) => reply(res, { tool_calls: [{ index: 0, id, type: "function",
  function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");

for (const origin of ["Task", "user"]) for (const phase of ["waiting-model", "waiting-subagents"])
for (const ending of ["agent.stopSubagents", "agent.disposeSession"]) {
  test(`${origin}/${phase}/${ending}: Main Stop preserves child plugin execution across a new parent turn`, { timeout: 25000 }, async t => {
    const profile = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "child-execution-e2e-"));
    const sessionId = "child-execution-user-path";
    const events = [], pluginCalls = [], requests = [], aborted = [], cleanup = [];
    const activeTurns = new Map(), handlers = new Map(), waiters = new Set(), pendingTools = new Map(), notifications = new Set();
    let heldParent, heldChild, parentRequests = 0, childRequests = 0, turnSerial = 0, stderr = "", sidecar;
    const changed = () => { for (const fn of [...waiters]) fn(); };
    const until = (check, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(poll); reject(new Error(`Timeout ${label}; ${stderr}`)); }, 8000);
      function poll() { if (check()) { clearTimeout(timer); waiters.delete(poll); resolve(); } }
      waiters.add(poll); poll();
    });
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const data of req) raw += data;
      const body = JSON.parse(raw), text = JSON.stringify(body.messages);
      const kind = text.includes("NEW_PARENT") ? "new" : text.includes("PARENT_TASK") ? "parent" : "child";
      requests.push(kind);
      res.on("close", () => { if (!res.writableEnded) aborted.push(kind); changed(); });
      if (kind === "new") reply(res, { content: "NEW_PARENT_DONE" });
      else if (kind === "parent") {
        if (origin === "Task" && ++parentRequests === 1) toolReply(res, "task", "Task", { agent: "worker", task: "CHILD_TASK" });
        else heldParent = res;
      } else {
        childRequests++;
        heldChild = res;
      }
      changed();
    });
    t.after(async () => {
      await sidecar?.dispose();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(profile, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const launch = {
      sessionId, mode: "agent", thinkingLevel: "off", scratchDir: profile,
      compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: { id: "fixture", modelId: "fixture-model", apiKey: "fixture-only", apiStyle: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, supportsReasoning: false, supportedThinkingLevels: ["off"], modelConfig: { input: ["text"] } },
      subagents: [{ name: "worker", description: "Fixture", prompt: "Fixture", source: "builtin", tools: ["plugin_fixture_echo"] }],
      pluginTools: [{ name: "plugin_fixture_echo", description: "Fixture", parameters: { type: "object", properties: {} } }],
    };
    const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
    const host = {
      isAvailable: () => true, onNotification(fn) { notifications.add(fn); return () => notifications.delete(fn); }, onExit() { return () => {}; },
      async call(method, params) {
        if (method === "session.get") return { session: { id: sessionId, mode: "agent", messages: [] } };
        if (method === "settings.get") return {};
        if (method === "session.beginTurn") return { turnId: `turn-${++turnSerial}` };
        if (method === "session.saveActiveRevision") return { saved: null };
        if (["session.appendMessage", "session.recordUsage", "plans.abort", "tools.abort"].includes(method)) return { ok: true };
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
        if (method === "project.instructions.resolve") return { entries: [] };
        if (method === "tools.execute") return new Promise(resolve => {
          pendingTools.set(params.toolCallId, resolve);
          const { executionOwnerId, runtimeId, ...payload } = params;
          for (const fn of notifications) fn("plugins.execute", { ...payload, executionId: params.toolCallId });
        });
        if (method === "plugins.resolveExecution") {
          pendingTools.get(params.executionId)?.(params); pendingTools.delete(params.executionId); return {};
        }
        throw new Error(`Unexpected Host method ${method}`);
      },
    };
    const loader = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(new URL("./helpers/ts-import-hooks.mjs", import.meta.url).href)});`)}`;
    sidecar = new AgentSidecar({ launch: { command: process.execPath,
      args: ["--experimental-transform-types", "--import", loader, fileURLToPath(new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url))],
      cwd: profile, env: { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
        PI_CODING_AGENT_DIR: profile, PI_DESKTOP_AGENTS_DIR: join(profile, "agents"), PI_SCRATCH_DIR: profile },
    }, onStderr: text => { stderr = (stderr + text).slice(-8000); } });
    const state = { host, sidecar, agentHostBridge: null };
    const invocations = new PluginToolInvocations(), pluginOwner = {};
    const plugins = { getTools: () => [{ fullName: "plugin_fixture_echo", pluginId: "fixture",
      async execute(args, ctx) {
        const invocation = invocations.begin(pluginOwner, { ...ctx, pluginId: "fixture", toolName: "echo" });
        pluginCalls.push(ctx); changed();
        try { return await invocations.run(pluginOwner, invocation.id, () => new Promise(resolve => { ctx.release = resolve; })); }
        finally { invocations.finish(invocation); }
      } }], drainToasts: () => [], broadcastEvent: (name, args, filter) => { if (filter("fixture")) cleanup.push({ name, payload: args[0] }); } };
    const finishTurn = async (id, _status, _code, options) => {
      if (activeTurns.get(id) === options.turnId) activeTurns.delete(id); changed();
    };
    const logger = { app() {}, flushChild() {} };
    createHostRuntime({ runtimeState: state, dataDir: profile, logger,
      persistenceOutbox: { size: () => 0, flush: async () => {} }, activeToolCalls: new Map(), activeToolCallKey: (s, c) => `${s}:${c}`,
      sessionProjects: new Map(), plugins, userMcp: {}, pluginActiveInProject: () => true, sendToRenderer() {}, emitAgentEvent() {},
      togglePluginLauncher: async () => {}, finishTurn, isTurnDispatchable: coordination.isTurnDispatchable,
      finishApprovedExecution: async () => {}, activeTurns, approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
      importLegacyScheduled: async () => {}, superviseRestart: async () => {}, isQuitting: () => false, ensureSystemProxyRelay: async () => "unused",
      currentNetworkDns: () => ({ mode: "system" }),
    }).wireHost(host);
    wireChildExecutionLifecycle(sidecar, { isCurrent: () => state.sidecar === sidecar, isTurnDispatchable: coordination.isTurnDispatchable,
      plugins, pluginActiveInProject: () => true, sessionProjects: new Map() });
    sidecar.setHost(host);
    sidecar.onNotification((method, params) => {
      if (method !== "agent.event") return;
      events.push(params);
      if (!params.parentToolCallId && params.event.type === "agent_end") void finishTurn(sessionId, null, null, { turnId: params.turnId });
      changed();
    });
    registerAgentIpc({ registrar: { handle: (name, fn) => handlers.set(name, fn) }, getHost: () => host, getSidecar: () => sidecar,
      getAgentHostBridge: () => null, logger, agentExtensions: { cancelPrompts() {} }, cancelSessionTools() { assert.fail("session-wide cancellation"); },
      persistenceOutbox: { flush: async () => {} }, dataDir: profile, activeTurns, completionNoticeTurns: new Set(), activeTurnUsages: new Map(),
      approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), recordTurnStart() {},
      isTurnDispatchable: coordination.isTurnDispatchable, lockAbortReason: coordination.lockAbortReason,
      async acquireSessionOperation() { return () => {}; }, finishTurn,
      async resolveAgentRuntimeLaunch() { return { providerId: "fixture", modelId: "fixture-model", sidecarParams: launch }; },
      async finishApprovedExecution() {}, async dispatchApprovedPlan() {}, async dispatchExecutionForProposal() {},
      // Staged mode runs are out of scope here: no run is claimed, so the plain
      // Agent turn path stays in effect.
      modeRuns: { canContinue: () => false, prepareTurn: async () => undefined, abandonTurn: async () => {} },
      emitAgentEvent() {}, setNotificationViewingSessionId() {}, optionalWorkspaceRoot: async () => null,
      composerCommandService: { buildComposerCommands: async () => [] }, loadComposerTemplatesCached: async () => [],
    });
    await handlers.get(IPC.invoke.agentPrompt)({ sessionId, content: "PARENT_TASK" });
    await until(() => heldParent, "parent provider");
    if (origin === "user") await handlers.get(IPC.invoke.agentSubagentControl)({ sessionId, operationId: "start", action: "start", agent: "worker", task: "CHILD_TASK" });
    await until(() => heldChild, "child provider");
    if (phase === "waiting-subagents") {
      toolReply(heldChild, "before-stop", "plugin_fixture_echo", {});
      await until(() => pluginCalls.length === 1, "plugin before stop");
      reply(heldParent, { content: "Waiting for child" });
      await until(() => events.some(e => e.event.type === "status" && e.event.status.activity?.phase === phase), "parent wait");
    }
    const oldTurn = activeTurns.get(sessionId);
    await handlers.get(IPC.invoke.agentAbort)({ sessionId, turnId: oldTurn });
    assert.equal(activeTurns.has(sessionId), false);
    assert.equal(aborted.includes("child"), false);
    // A changed launch must not silently dispose a detached worker.
    await assert.rejects(sidecar.call("agent.prompt", { ...launch, provider: { ...launch.provider, modelId: "different" },
      content: "CHANGED_CONFIG", turnId: "unused" }), error => error.errorCode === "AGENT_BUSY");
    const next = await handlers.get(IPC.invoke.agentPrompt)({ sessionId, content: "NEW_PARENT" });
    assert.notEqual(next.turnId, oldTurn);
    await until(() => events.some(e => e.event.type === "message_end" && e.event.message.content === "NEW_PARENT_DONE"), "new parent");
    if (phase === "waiting-subagents") {
      assert.equal(pluginCalls[0].signal.aborted, false);
      pluginCalls[0].release("before completed");
      await until(() => childRequests === 2, "child continuation");
    }
    toolReply(heldChild, "after-stop", "plugin_fixture_echo", {});
    const expected = phase === "waiting-subagents" ? 2 : 1;
    await until(() => pluginCalls.length === expected, "plugin after stop");
    const call = pluginCalls.at(-1);
    assert.notEqual(call.turnId, oldTurn); assert.notEqual(call.turnId, next.turnId);
    assert.equal(call.signal.aborted, false);
    assert.equal(cleanup.length, 0, "parent end must not clean up child resources");
    if (expected === 2) assert.equal(pluginCalls[0].turnId, call.turnId);
    await sidecar.call(ending, { sessionId });
    assert.equal(call.signal.aborted, true);
    await until(() => cleanup.some(e => e.name === "session:turnEnded" && e.payload.turnId === call.turnId), "child cleanup");
    assert.equal(aborted.includes("child"), false, "child provider was never cancelled by parent stop or launch mismatch");
    assert.equal(requests.filter(kind => kind === "new").length, 1);
  });
}
