#!/usr/bin/env node
/** Offline staged-mode acceptance against a real isolated Host process. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { register } from "node:module";
import { resolveHostBinary } from "./e2e/host.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { beginTurn, createSession, endTurn } from "./e2e/session.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createModeRunCoordinator } = await import("../apps/desktop/electron/main/runtime/mode-runs.ts");
const { createModeCatalogService } = await import("../apps/desktop/electron/main/runtime/mode-catalog.ts");
const { registerAgentIpc } = await import("../apps/desktop/electron/main/ipc/agent-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

const root = process.env.PI_SCRATCH_DIR;
assert.ok(root, "PI_SCRATCH_DIR is required for isolated test state");
const temp = join(root, "mode-e2e");
await mkdir(temp, { recursive: true });
await withScenario("mode-workflow", async ({ host, workspace }) => {
  const session = await createSession(host, workspace, "Mode acceptance");
  const sessionId = session.id;
  const definition = {
    version: 1, id: "acceptance", label: "Acceptance", description: "Offline test",
    source: "user", permission: "agent", prompt: "Verify the requested change.",
    artifacts: [{ id: "spec", path: ".pi/runs/{{run.id}}/spec.md", requiredHeadings: ["Goal", "Evidence"] }],
    budget: { maxTurns: 20, maxTokens: null }, returnTo: "agent",
    stages: [
      { id: "draft", permission: "contract", prompt: "Draft the spec.", loop: false,
        onEnter: [], onCompaction: [], next: "verify",
        exit: [{ kind: "require", artifact: "spec", onFail: { retries: 2 } }, { kind: "ask" }] },
      { id: "verify", permission: "agent", prompt: "Verify.", loop: true,
        onEnter: [], onCompaction: [],
        exit: [{ kind: "run", command: "echo mode-gate-ok", timeoutMinutes: 1, onFail: { retries: 0 } }] },
    ],
  };
  await host.call("session.configure", { id: sessionId, mode: definition.id, modeSnapshot: definition, permissionMode: "auto" });
  const turnId = await beginTurn(host, sessionId);
  const claim = await host.call("modes.start", { sessionId, turnId, input: "Produce and verify a spec" });
  assert.equal(claim.claimed, true);
  const runId = claim.run.id;
  const failed = await host.call("modes.completeStage", { sessionId, runId, turnId, summary: "Not ready" });
  assert.equal(failed.status, "failed");
  const markdown = "# Goal\nProduce a spec.\n# Evidence\nValidated offline.\n";
  const approval = await host.call("modes.completeStage", { sessionId, runId, turnId, summary: "Ready", artifacts: { spec: markdown } });
  assert.equal(approval.status, "awaiting_approval");
  assert.equal(await readFile(join(workspace, claim.run.artifactPaths.spec), "utf8"), markdown);
  await endTurn(host, turnId);
  const settled = await host.call("modes.settleTurn", { sessionId, runId, turnId, tokens: 12, outcome: "completed" });
  assert.equal(settled.continue, false);
  const resolved = await host.call("modes.resolve", { sessionId, runId, expectedRevision: settled.run.revision, action: "approve" });
  assert.equal(resolved.continue, true);
  const secondTurn = await beginTurn(host, sessionId);
  const secondClaim = await host.call("modes.claimTurn", {
    sessionId, runId, expectedRevision: resolved.run.revision, turnId: secondTurn, origin: "approval",
  });
  assert.equal(secondClaim.run.stageId, "verify");
  const gate = await host.call("modes.completeStage", { sessionId, runId, turnId: secondTurn, summary: "Verify" });
  assert.equal(gate.status, "run");
  const shell = (await host.call("commandShells.list")).effective;
  const toolCallId = "mode-verify-command";
  await assert.rejects(host.call("tools.execute", {
    sessionId, turnId: secondTurn, toolCallId: "wrong-command", toolName: "Bash", mode: "agent",
    args: { command: "echo wrong" }, modeGate: { runId, gateIndex: gate.gateIndex },
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  }), (error) => error.errorCode === "MODE_GATE_MISMATCH");
  const executed = await host.call("tools.execute", {
    sessionId, turnId: secondTurn, toolCallId, toolName: "Bash", mode: "agent",
    args: { command: gate.command }, modeGate: { runId, gateIndex: gate.gateIndex },
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  assert.equal(executed.ok, true);
  const finished = await host.call("modes.gateResult", { sessionId, runId, turnId: secondTurn, gateIndex: gate.gateIndex, toolCallId });
  assert.equal(finished.status, "finished");
  await endTurn(host, secondTurn);
  await host.call("modes.settleTurn", { sessionId, runId, turnId: secondTurn, tokens: 3, outcome: "completed" });
  assert.equal((await host.call("session.get", { id: sessionId, messageLimit: 1 })).session.mode, "agent");
  assert.equal((await host.call("modes.get", { sessionId })).run, null);
  console.log("PASS mode snapshot -> artifact checks -> approval -> command gate -> completion -> Agent");
}, resolveHostBinary(), temp);

await withScenario("mode-snapshot-dispatch", async ({ host, workspace, dataDir }) => {
  const catalog = createModeCatalogService({ dir: join(dataDir, "modes") });
  await catalog.write("review", "---\nname: review\npermission: contract\nstages:\n  work:\n    prompt: Keep the original stage.\n    exit: [{ ask: user }]\n---\nOriginal instructions.\n");
  const definition = await catalog.definition("review");
  const { session } = await host.call("session.create", {
    title: "Snapshot dispatch", projectPath: workspace, mode: "review", modeSnapshot: definition,
  });
  const handlers = new Map();
  const prompts = [];
  const activeTurns = new Map();
  const coordinator = createModeRunCoordinator({
    getHost: () => host, catalog, logger: { app() {} }, isQuitting: () => false,
    startContinuation: async () => assert.fail("non-looping stage must not continue automatically"),
  });
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    modeRuns: coordinator, getHost: () => host, getAgentHostBridge: () => null,
    getSidecar: () => ({
      setProjectInstructionRoot() {},
      async call(method, params) {
        assert.equal(method, "agent.prompt");
        prompts.push(params);
        return { accepted: true, turnId: params.turnId };
      },
    }),
    logger: { app() {} }, persistenceOutbox: {}, dataDir, activeTurns,
    activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart() {}, acquireSessionOperation: async () => () => {},
    resolveAgentRuntimeLaunch: async () => ({
      providerId: "fixture", modelId: "fixture", workspaceRoot: workspace,
      sidecarParams: { sessionId: session.id, mode: "review", provider: { modelConfig: { input: ["text"] } } },
    }),
    finishTurn: async (_sessionId, status, _error, { turnId }) => {
      await endTurn(host, turnId, status);
      activeTurns.delete(session.id);
    },
    emitAgentEvent() {}, setNotificationViewingSessionId() {},
  });
  const send = async () => {
    const result = await handlers.get(IPC.invoke.agentPrompt)({ sessionId: session.id, content: "Review the change." });
    assert.equal(result.accepted, true);
    await endTurn(host, result.turnId);
    await coordinator.settleTurn(session.id, result.turnId, { reason: "completed" });
    activeTurns.delete(session.id);
    return prompts.at(-1);
  };
  const first = await send();
  assert.deepEqual(first.modeDefinition, definition);
  assert.ok(first.modeTurn.runId);
  await catalog.write("review", "---\nname: review\npermission: agent\n---\nReplacement simple mode.\n");
  const edited = await send();
  assert.deepEqual(edited.modeDefinition, definition);
  assert.equal(edited.modeTurn.runId, first.modeTurn.runId);
  await catalog.remove("review");
  const removed = await send();
  assert.deepEqual(removed.modeDefinition, definition);
  assert.equal(removed.modeTurn.runId, first.modeTurn.runId);
  const current = (await host.call("modes.get", { sessionId: session.id })).run;
  await coordinator.control({ sessionId: session.id, runId: current.id, expectedRevision: current.revision, action: "remove" });
  await host.call("session.configure", { id: session.id, mode: "review", modeSnapshot: { ...definition, stages: [] } });
  const before = (await host.call("session.get", { id: session.id })).session.messages;
  assert.equal(before.length, 3);
  await assert.rejects(
    handlers.get(IPC.invoke.agentPrompt)({ sessionId: session.id, content: "Unavailable mode." }),
    { errorCode: "MODE_NOT_FOUND" },
  );
  assert.equal(prompts.length, 3);
  assert.equal(activeTurns.size, 0);
  assert.deepEqual((await host.call("session.get", { id: session.id })).session.messages, before);
  console.log("PASS production prompt IPC -> coordinator -> real Host snapshot after catalog edit/removal; missing mode closes admission");
}, resolveHostBinary(), temp);
