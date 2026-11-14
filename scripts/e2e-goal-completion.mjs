#!/usr/bin/env node
/** Real production sidecar/proxy/Host completion; only the model is a loopback fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { setImmediate as nextEventLoop } from "node:timers/promises";
import { resolveHostBinary } from "./e2e/host.mjs";
import { createSession, beginTurn, endTurn } from "./e2e/session.mjs";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { HostProcess } from "../packages/host-runtime/dist/host-process.js";
import { TurnEventPipeline } from "../packages/host-runtime/dist/turn-events.js";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createModeRunCoordinator } = await import("../apps/desktop/electron/main/runtime/mode-runs.ts");
const { createModeCatalogService } = await import("../apps/desktop/electron/main/runtime/mode-catalog.ts");
const { createSessionCoordination } = await import("../apps/desktop/electron/main/runtime/session-coordination.ts");
const { createPlanRuntime } = await import("../apps/desktop/electron/main/runtime/plans.ts");
const { createAgentHostBridge } = await import("../apps/desktop/electron/main/agent-host-bridge.ts");
const { builtinModeDefinition } = await import("../packages/agent-runtime/dist/mode-definitions.js");
const { IPC } = await import("@pi-desktop/shared");
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch, "PI_SCRATCH_DIR is required");
const root = await mkdtemp(join(scratch, "goal-completion-"));
const agents = join(root, "agents");
await mkdir(agents, { recursive: true });
const entry = resolve(process.env.PI_DESKTOP_SIDECAR_ENTRY ?? fileURLToPath(new URL("../packages/agent-runtime/dist-bundle/sidecar.js", import.meta.url)));
const binary = resolveHostBinary();

async function scenario(kind) {
  const dir = join(root, kind);
  const dataDir = join(dir, "data");
  const workspace = join(dir, "workspace");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
  const env = { PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_AGENTS_DIR: agents, TMP: scratch, TEMP: scratch, TMPDIR: scratch };
  let host;
  let sidecar;
  let pipeline;
  let requests = 0;
  const errors = [];
  const settlements = [];
  const stageOutcomes = [];
  let continuations = 0;
  let gateApprovals = 0;
  let completedArgs;
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      assert.equal(request.url, "/v1/chat/completions");
      assert.ok(body.tools.some((tool) => tool.function?.name === "CompleteStage"));
      requests += 1;
      const delta = requests === 1
        ? { role: "assistant", tool_calls: [{ index: 0, id: "completion-call", type: "function", function: { name: "CompleteStage", arguments: JSON.stringify(completedArgs) } }] }
        : { role: "assistant", content: "Unexpected extra model request" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500);
      response.end("Fixture rejected request");
    }
  });
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const startHost = async () => {
      const process = new HostProcess({ binaryPath: binary, dataDir, env, onStderr() {} });
      await process.handshake();
      await process.call("workspace.set", { path: workspace });
      return process;
    };
    host = await startHost();
    const session = await createSession(host, workspace, `Completion ${kind}`);
    const sessionId = session.id;
    host.onNotification((method, params) => {
      if (method !== "permissions.request") return;
      const allowed = kind === "gate" && params.sessionId === sessionId && params.toolName === "Bash"
        && String(params.toolCallId).startsWith("mode-gate-") && JSON.stringify(params.argsPreview).includes("echo completion-gate-ok");
      if (allowed) gateApprovals += 1;
      else errors.push("Unexpected permission request");
      void host.call("permissions.resolve", { requestId: params.requestId, decision: allowed ? "allow-once" : "deny" })
        .catch((error) => errors.push(String(error)));
    });
    const definition = builtinModeDefinition("goal");
    assert.ok(definition);
    if (kind === "snapshot") definition.stages[0].prompt = "Legacy snapshot: complete only when all work is verified.";
    if (kind === "gate") {
      definition.id = "completion-gate";
      definition.source = "user";
      definition.stages[0].exit.push({ kind: "run", command: "echo completion-gate-ok", timeoutMinutes: 1, onFail: { retries: 0 } });
    }
    await host.call("session.configure", { id: sessionId, mode: definition.id, modeSnapshot: definition, permissionMode: "auto" });
    const resumedSnapshot = kind === "snapshot" || kind === "gate";
    if (resumedSnapshot) {
      const seedTurn = await beginTurn(host, sessionId);
      const seed = await host.call("modes.start", { sessionId, turnId: seedTurn, input: "Verify the completion fixture" });
      await endTurn(host, seedTurn, "aborted");
      const paused = await host.call("modes.settleTurn", { sessionId, runId: seed.run.id, turnId: seedTurn, tokens: 0, outcome: "aborted" });
      await host.call("modes.control", { sessionId, runId: seed.run.id, expectedRevision: paused.run.revision, action: "resume" });
    }
    const port = { async call(method, params) {
      const answer = await host.call(method, params);
      if (method === "modes.settleTurn") settlements.push(answer);
      return answer;
    } };
    const activeTurns = new Map();
    const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
    const bridge = createAgentHostBridge({ channels: IPC.invoke, getHost: () => port, isSessionBusy: coordination.isSessionBusy,
      invoke: async () => { throw new Error("No extra turn is authorized by this fixture"); }, log() {} });
    const runs = createModeRunCoordinator({ getHost: () => port, catalog: createModeCatalogService({ dir: join(dataDir, "modes") }),
      logger: { app() {} }, isQuitting: () => false, startContinuation: async () => { continuations += 1; },
      abortTurn: async () => {}, notifyTurn: async () => {},
    });
    const plans = createPlanRuntime({
      runtimeState: { host: port, agentHostBridge: bridge }, planState: { approvedExecutionDrain: null }, logger: { app() {} },
      sendToRenderer() {}, coordination, scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
      approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), approvedExecutionTurns: new Map(),
      startedApprovedExecutions: new Set(), finishedApprovedExecutions: new Set(), dispatchingApprovedExecutions: new Set(),
      inFlightExecutionFinishes: new Set(), pendingExecutionFinishes: new Map(), announceTurnEnded() {}, emitAgentEvent() {},
      acquireSessionOperation: coordination.acquireSessionOperation, isQuitting: () => false,
      onTurnEnded: (...args) => runs.settleTurn(...args),
    });
    const turnId = await beginTurn(host, sessionId);
    activeTurns.set(sessionId, turnId);
    coordination.recordTurnStart(sessionId, turnId);
    const prepared = await runs.prepareTurn({ sessionId, turnId, sessionMode: definition.id, origin: resumedSnapshot ? "host" : "user", content: "Verify the completion fixture" });
    assert.ok(prepared?.modeTurn);
    const runId = prepared.modeTurn.runId;
    const markdown = "# Objective\nVerify the completion fixture\n# Acceptance criteria\nObserve a real Host completion\n# Evidence\nDeterministic loopback model and real Host.\n";
    const report = kind === "blocked"
      ? { status: "blocked", outcomes: [{ criterion: "Approval", outcome: "unverified", evidence: "Only the user can approve the missing prerequisite" }], remainingWork: ["Verify after user approval"], blockerReason: "A required user decision is missing" }
      : { status: "completed", outcomes: [{ criterion: "Completion fixture", outcome: "met", evidence: "The scripted fixture reached the authorized completion step" }], remainingWork: [] };
    completedArgs = { summary: `Fixture ${kind}`, ...(kind === "blocked" ? {} : { artifacts: { goal: markdown } }), ...(kind === "legacy" ? {} : { report }) };
    const finished = Promise.withResolvers();
    const ended = Promise.withResolvers();
    let finalization;
    pipeline = new TurnEventPipeline({ getHost: () => host,
      ownership: { activeTurnId: (id) => activeTurns.get(id),
        isStaleTerminalEvent: coordination.isStaleTerminalEvent,
        finishTurn: (...args) => {
          finalization ??= plans.finishTurn(...args);
          void finalization.then(finished.resolve, finished.reject);
          return finalization;
        },
      },
      emit: (event) => {
        bridge.ingest(event);
        if (event.event.type === "agent_end") ended.resolve();
        if (event.event.type === "error") errors.push(event.event.error.code);
      }, log() {},
    });
    sidecar = new AgentSidecar({ launch: { command: process.execPath, args: [entry], cwd: workspace, env: { ...process.env, ...env } }, onStderr() {} });
    sidecar.setHost({
      async call(method, params) {
        if (kind === "fault" && method === "modes.completeStage") throw Object.assign(new Error("fixture unavailable completion RPC"), { code: -32601 });
        const answer = await host.call(method, params);
        if (method === "modes.completeStage" || method === "modes.gateResult") stageOutcomes.push(answer);
        return answer;
      }, onNotification: (handler) => host.onNotification(handler), onExit: (handler) => host.onExit(handler),
    });
    sidecar.onNotification((method, event) => {
      if (method !== "agent.event") return;
      if (event.event.type === "agent_end") ended.resolve();
      pipeline.handle(event);
    });
    await sidecar.call("sidecar.configure", { networkProxy: { mode: "direct" } });
    const shell = (await host.call("commandShells.list")).effective;
    await sidecar.call("agent.prompt", {
      sessionId, turnId, content: "Verify the completion fixture", mode: definition.id, modeDefinition: prepared.definition, modeTurn: prepared.modeTurn,
      workspaceRoot: workspace, projectPath: workspace, projectInstructions: { entries: [] }, scratchDir: dir,
      commandShell: shell, thinkingLevel: "off", trustedExtensions: [], pluginTools: [], pluginSkills: [], subagents: [],
      compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      provider: { id: "fixture", name: "Offline fixture", vendorKey: "custom", baseUrl, modelId: "fixture", apiKey: "fixture-only",
        apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"],
        modelConfig: { source: "generic", name: "Fixture", baseUrl, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
      },
    });
    let deadline;
    try {
      await Promise.race([Promise.all([finished.promise, ended.promise]), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Completion timed out: ${kind}; ${errors.join(", ")}`)), 30000); })]);
    } finally { clearTimeout(deadline); }
    await nextEventLoop();
    assert.equal(requests, 1, "no next model request after completion, blocker or infrastructure failure");
    assert.equal(gateApprovals, kind === "gate" ? 1 : 0, "the custom Host-origin gate retains its permission ceiling");
    assert.equal(settlements.length, 1, "error plus agent_end settles once");
    const settled = settlements[0];
    assert.equal(settled.continue, false);
    assert.equal(settled.run.activeTurnId, undefined);
    assert.equal(await runs.canContinue(sessionId), false);
    assert.equal(continuations, 0, "Main must not schedule another autonomous round");
    if (kind === "blocked") {
      assert.equal(settled.run.state, "waiting");
      assert.equal(settled.run.waitReason, "blocked");
      assert.deepEqual(settled.run.completionReport, report);
      assert.equal(stageOutcomes[0].status, "blocked");
      assert.deepEqual(errors, []);
    } else if (kind === "fault") {
      assert.equal(settled.run.state, "waiting");
      assert.equal(settled.run.waitReason, "error");
      assert.equal(settled.run.roundsCompleted, 0);
      assert.deepEqual(errors, ["MODE_COMPLETE_STAGE_FAILED"]);
    } else {
      assert.equal(settled.run.state, "finished");
      assert.equal(stageOutcomes.at(-1).status, "finished");
      assert.equal((await host.call("modes.get", { sessionId })).run, null);
      assert.equal(await readFile(join(workspace, prepared.modeTurn.artifactPaths.goal), "utf8"), markdown);
      if (kind === "gate") assert.deepEqual(stageOutcomes.map((outcome) => outcome.status), ["run", "finished"]);
      assert.deepEqual(errors, []);
    }
    const again = await host.call("modes.settleTurn", { sessionId, runId, turnId, tokens: 999, outcome: "completed" });
    assert.equal(again.continue, false);
    assert.equal(again.run.tokensUsed, settled.run.tokensUsed);
    assert.equal(again.run.roundsCompleted, settled.run.roundsCompleted);
    await sidecar.dispose(); sidecar = undefined;
    await pipeline.dispose(); pipeline = undefined;
    await host.dispose();
    host = await startHost();
    const restored = (await host.call("modes.get", { sessionId })).run;
    if (kind === "blocked" || kind === "fault") {
      assert.equal(restored.state, "waiting");
      assert.equal(restored.waitReason, kind === "blocked" ? "blocked" : "error");
      assert.equal(restored.activeTurnId, undefined);
      if (kind === "blocked") assert.deepEqual(restored.completionReport, report);
    } else assert.equal(restored, null);
    console.log(`PASS ${kind}: production sidecar -> stdio proxy -> real Host -> Main settlement; no continuation; duplicate settlement and restart safe`);
  } finally {
    await sidecar?.dispose();
    await pipeline?.dispose();
    await host?.dispose();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

try {
  for (const kind of ["finished", "legacy", "blocked", "fault", "gate", "snapshot"]) await scenario(kind);
} finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
