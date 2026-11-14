#!/usr/bin/env node
/** Goal acceptance through production Main admission and a real isolated Host. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { register } from "node:module";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createModeRunCoordinator } = await import("../apps/desktop/electron/main/runtime/mode-runs.ts");
const { createModeCatalogService } = await import("../apps/desktop/electron/main/runtime/mode-catalog.ts");
const { createSessionCoordination } = await import("../apps/desktop/electron/main/runtime/session-coordination.ts");
const { createPlanRuntime } = await import("../apps/desktop/electron/main/runtime/plans.ts");
const { createAgentHostBridge } = await import("../apps/desktop/electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../apps/desktop/electron/main/ipc/agent-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch, "PI_SCRATCH_DIR is required");
const temp = join(scratch, "goal-run-acceptance");
await mkdir(temp, { recursive: true });
await withScenario("goal-repairs", async ({ host, workspace, dataDir }) => {
  const session = await createSession(host, workspace, "Goal repairs");
  const sessionId = session.id;
  await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
  const settlements = [];
  const port = { async call(method, params) {
    const value = await host.call(method, params);
    if (method === "modes.settleTurn") settlements.push(value);
    return value;
  } };
  const handlers = new Map();
  const prompts = [];
  const promptWaiters = new Map();
  const waitForPrompt = count => prompts.length >= count ? Promise.resolve(prompts[count - 1]) :
    new Promise(resolve => promptWaiters.set(count, resolve));
  const activeTurns = new Map();
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  let bridge;
  let plans;
  const catalog = createModeCatalogService({ dir: join(dataDir, "modes") });
  const runs = createModeRunCoordinator({
    getHost: () => port, catalog, logger: { app() {} }, isQuitting: () => false,
    startContinuation: (...args) => bridge.startModeContinuation(...args),
    abortTurn: async id => {
      const turnId = activeTurns.get(id);
      assert.ok(turnId, "replacement must abort only the old active turn");
      await plans.finishTurn(id, "aborted", undefined, { turnId });
    },
    notifyTurn: async () => {},
  });
  bridge = createAgentHostBridge({
    channels: IPC.invoke, getHost: () => port, isSessionBusy: coordination.isSessionBusy,
    invoke: (channel, args) => handlers.get(channel)(...args), log() {},
  });
  plans = createPlanRuntime({
    runtimeState: { host: port, agentHostBridge: bridge }, planState: { approvedExecutionDrain: null },
    logger: { app() {} }, sendToRenderer() {}, coordination,
    scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(), dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(), pendingExecutionFinishes: new Map(), announceTurnEnded() {}, emitAgentEvent() {},
    acquireSessionOperation: coordination.acquireSessionOperation, isQuitting: () => false,
    onTurnEnded: (...args) => runs.settleTurn(...args),
  });
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    modeRuns: runs, getHost: () => port, getAgentHostBridge: () => bridge,
    getSidecar: () => ({
      setProjectInstructionRoot() {},
      async call(method, params) {
        assert.equal(method, "agent.prompt");
        const message = { id: `answer-${prompts.length + 1}`, role: "assistant", content: "Synthetic answer", status: "complete", createdAt: new Date().toISOString() };
        await host.call("session.appendMessage", { sessionId, turnId: params.turnId, message });
        bridge.ingest({ sessionId, turnId: params.turnId, ts: Date.now(), event: { type: "agent_start" } });
        prompts.push(params);
        promptWaiters.get(prompts.length)?.(params);
        return { accepted: true, turnId: params.turnId };
      },
    }),
    logger: { app() {} }, persistenceOutbox: {}, dataDir, activeTurns, completionNoticeTurns: new Set(),
    activeTurnUsages: coordination.activeTurnUsages, approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart: coordination.recordTurnStart, acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => {
      const current = (await host.call("session.get", { id: sessionId, messageLimit: 1 })).session;
      return { providerId: "fixture", modelId: "fixture", workspaceRoot: workspace,
        sidecarParams: { sessionId, mode: current.mode, provider: { modelConfig: { input: ["text"] } } } };
    },
    finishTurn: plans.finishTurn, emitAgentEvent() {}, setNotificationViewingSessionId() {},
  });
  const first = await handlers.get(IPC.invoke.agentPrompt)({ sessionId, content: "first objective", startGoal: true });
  assert.equal(first.accepted, true);
  const original = prompts[0].modeTurn.runId;
  assert.equal((await host.call("session.get", { id: sessionId, messageLimit: 1 })).session.mode, "agent");
  assert.equal((await runs.get(sessionId)).run.state, "running");
  coordination.activeTurnUsages.set(sessionId, { inputTokens: 3, outputTokens: 2 });
  const automatic = waitForPrompt(2);
  await plans.finishTurn(sessionId, "completed", undefined, { turnId: first.turnId });
  const continued = await automatic;
  assert.equal(continued.mode, "goal");
  assert.equal(continued.modeTurn.runId, original);
  assert.equal(continued.modeTurn.origin, "host");
  const decision = await host.call("permissions.evaluate", { sessionId, toolName: "Bash", args: { command: "echo goal-continuation" } });
  assert.equal(decision.decision, "allow-once", "second turn retains Auto after input reset");
  coordination.activeTurnUsages.set(sessionId, { inputTokens: 7, outputTokens: 1 });
  const replacement = await handlers.get(IPC.invoke.agentQueuePush)({ sessionId, content: "second objective", startGoal: true });
  assert.ok(replacement.id);
  const replaced = await waitForPrompt(3);
  const current = (await runs.get(sessionId)).run;
  assert.notEqual(current.id, original);
  assert.equal(current.id, replaced.modeTurn.runId);
  assert.equal(current.input, "second objective");
  assert.equal(current.roundsCompleted, 0);
  assert.equal(current.tokensUsed, 0);
  assert.equal(current.state, "running");
  const old = settlements.filter(value => value.run.id === original).at(-1);
  assert.equal(old.run.state, "stopped");
  assert.equal(old.run.roundsCompleted, 1);
  assert.equal(old.run.tokensUsed, 13);
  assert.equal(old.continue, false);
  const detail = (await host.call("session.get", { id: sessionId })).session;
  const answers = detail.messages.filter(message => message.role === "assistant");
  assert.equal(answers.length, 3);
  assert.equal(new Set(answers.map(message => message.turnId)).size, 3);
  assert.equal(detail.messages.filter(message => message.role === "user").length, 2, "autonomous turns create no synthetic user rows");
  assert.equal(detail.mode, "agent");
  assert.equal(bridge.queue.list(sessionId).length, 0);
  await runs.control({ sessionId, runId: current.id, expectedRevision: current.revision, action: "stop" });
  assert.equal((await runs.get(sessionId)).run, null);
  console.log("PASS Goal -> Agent input -> automatic Goal with Auto -> durable second Goal replacement -> separate transcript turns -> Stop");
}, resolveHostBinary(), temp);
