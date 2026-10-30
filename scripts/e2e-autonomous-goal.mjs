#!/usr/bin/env node
/** Real Rust host + Node sidecar + shared admission; loopback model fixture only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHost } from "../packages/agent-host/dist/index.js";
import { AgentSidecar, HostProcess, RuntimeService, GoalCoordinator, createHostSessionPort, createHostQueueStore } from "../packages/host-runtime/dist/index.js";

assert(process.env.PI_HOST_CORE_BINARY, "Set PI_HOST_CORE_BINARY to this candidate's host-core binary");
const binary = resolve(process.env.PI_HOST_CORE_BINARY);
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "goal-e2e-"));
const dataDir = join(root, "data"), workspace = join(root, "workspace"), home = join(root, "home");
await Promise.all([dataDir, workspace, home].map(path => mkdir(path, { recursive: true })));
const objective = "Demonstrate the required execution checkpoints";
const scenario = process.env.GOAL_E2E_SCENARIO || "completion";
assert(["completion", "turn-budget", "token-budget", "finite-both", "unlimited", "audit-recovery", "settings-default", "pause"].includes(scenario));
const completing = ["completion", "unlimited", "audit-recovery"].includes(scenario);
const expectedTurns = scenario === "unlimited" ? 21 : scenario === "completion" ? 2 : 1;
const expectedRequests = scenario === "audit-recovery" ? 3 : completing ? expectedTurns + 1 : 1;
const expectedBudget = ["unlimited", "token-budget", "settings-default"].includes(scenario)
  ? { maxTurns: null, ...(scenario === "unlimited" ? {} : { maxTokens: 1 }) }
  : scenario === "finite-both" ? { maxTurns: 4, maxTokens: 1 }
  : { maxTurns: scenario === "turn-budget" ? 1 : 20 };
const validAudit = { version: 1, objective,
  items: [{ requirement: objective, outcome: "met", evidence: "The controlled fixture reached the required execution checkpoint." }], remainingWork: [] };
let correctedToolError = false;
const requests = [];
let requestArrived, releaseResponse;
const firstRequest = new Promise(resolve => { requestArrived = resolve; });
const responseReleased = new Promise(resolve => { releaseResponse = resolve; });
let fixtureError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of req) { body += chunk; assert(body.length < 2_000_000); }
    requests.push(JSON.parse(body));
    assert(requests.length <= expectedRequests, "Unexpected extra model request");
    if (scenario === "audit-recovery" && requests.length === 2) {
      const toolResults = requests.at(-1).messages.filter(message => message.role === "tool");
      assert(toolResults.length > 0, "Missing failed report tool result");
      const text = JSON.stringify(toolResults);
      assert(/audit/i.test(text) && /required|requires|missing|invalid|completion/i.test(text), "Missing recoverable audit refusal: " + text);
      assert(!text.includes('"status":"completed"'), "Unaudited completion was persisted");
      correctedToolError = true;
    }
    requestArrived();
    if (scenario === "pause") await responseReleased;
    const tool = completing && (scenario === "audit-recovery" ? requests.length <= 2 : requests.length === expectedTurns);
    const audit = scenario === "audit-recovery" && requests.length === 1 ? {} : { audit: validAudit };
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
      name: "UpdateGoal", arguments: JSON.stringify({ status: "completed", progressSummary: "The required execution checkpoints were reached.",
        outcomes: [{ criterion: objective, outcome: "met", evidence: "The controlled fixture reached the required execution checkpoint." }], ...audit }),
    } }] } : { role: "assistant", content: requests.length === 1 ? "The goal is complete. This is only a plain final answer, not a structured completion report." : "The requested evidence has been reported." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [value, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, model: "goal-fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { fixtureError = error; res.writeHead(500); res.end("Fixture rejected the request"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const isolatedEnv = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PI_DESKTOP_DATA_DIR: dataDir };
let host, sidecar, runtime;
let stderr = "";
const errors = [], goalEvents = [], eventTrace = [];
let resolveEnded;
const ended = new Promise(resolve => { resolveEnded = resolve; });
let terminalCount = 0;
const timeout = setTimeout(() => resolveEnded(new Error(`Goal E2E deadline exceeded. ${JSON.stringify({ requests: requests.length, errors, goalEvents, eventTrace, terminalCount })} ${stderr}`)), 30_000);
const openHost = () => new HostProcess({ binaryPath: binary, dataDir, env: isolatedEnv, onStderr: text => { stderr += text; } });
try {
  host = openHost();
  await host.handshake();
  await host.call("workspace.set", { path: workspace });
  const { session } = await host.call("session.create", { title: "Autonomous Goal fixture", projectPath: workspace, mode: "goal" });
  assert(session?.id);
  await host.call("session.configure", { id: session.id, mode: "goal", permissionMode: "ask" });
  sidecar = new AgentSidecar({ launch: { command: process.execPath,
    args: [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))],
    cwd: workspace, env: { ...process.env, ...isolatedEnv } }, onStderr: text => { stderr += text; } });
  sidecar.setHost(host);
  const commandShell = (await host.call("commandShells.list")).effective;
  assert(commandShell?.available);
  const goals = new GoalCoordinator(() => host);
  let agentHost;
  runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar,
    log: (level, message, data) => { if (level === "error") errors.push({ message, data }); },
    pauseGoal: id => agentHost.pauseGoal(id),
    launch: { async resolve(sessionId) { return { providerId: "fixture", modelId: "goal-fixture", projectPath: workspace,
      sidecarParams: { sessionId, commandShell, mode: "goal", projectPath: workspace, thinkingLevel: "off", scratchDir: join(root, "agent"),
        provider: { id: "fixture", name: "Local fixture", modelId: "goal-fixture", baseUrl, apiStyle: "chat_completions",
          apiKey: "local-fixture-not-a-secret", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] } } }; } },
  });
  agentHost = new AgentHost({ runtime, goals, sessions: createHostSessionPort(() => host), queueStore: createHostQueueStore(() => host),
    approvals: { async resolveTool(id, decision) { await host.call("permissions.resolve", { requestId: id, decision }); },
      async resolveContract() { throw new Error("Goal must not request plan approval"); }, async listPendingTools() { return []; } } });
  runtime.attachHost(host); runtime.attachSidecar(sidecar);
  runtime.onEvent(event => { eventTrace.push(event.event.type); if (event.event.type === "error") errors.push(event.event.error); agentHost.ingest(event); });
  runtime.onTurnEnded(info => {
    agentHost.endTurn(info.sessionId, info.turnId, info.reason === "completed" ? "completed" : "failed");
    void agentHost.kick(info.sessionId).then(() => { if (++terminalCount === expectedTurns) resolveEnded(); }).catch(resolveEnded);
  });
  host.onNotification((method, params) => { if (method === "goals.changed") goalEvents.push(params); });
  await agentHost.start();
  if (scenario === "settings-default") await host.call("settings.set", { defaultGoalBudget: expectedBudget });
  await agentHost.startGoal({ subject: "fixture-user", roles: ["owner"], pairedDevice: true }, {
    sessionId: session.id, input: { text: objective, userMessageId: randomUUID() }, context: { requestId: "goal-user-submit" },
    ...(scenario === "settings-default" || scenario === "completion" || scenario === "audit-recovery" || scenario === "pause" ? {} : { budget: expectedBudget }),
  });
  if (scenario === "pause") {
    await Promise.race([firstRequest, ended.then(error => { throw error || new Error("Turn ended before pause"); })]);
    const { goal: running } = await host.call("goals.get", { sessionId: session.id });
    await agentHost.controlGoal({ subject: "fixture-user", roles: ["owner"], pairedDevice: true }, {
      sessionId: session.id, goalId: running.id, expectedRevision: running.revision, action: "pause",
    });
    releaseResponse();
  }
  const failure = await ended;
  if (failure) throw failure;
  if (fixtureError) throw fixtureError;
  if (scenario === "audit-recovery") {
    assert.equal(errors.length, 1, "Exactly one intentional invalid UpdateGoal must be observable");
    assert.equal(errors[0].message, "tool execution failed");
    assert.equal(errors[0].data?.toolName, "UpdateGoal");
    assert(correctedToolError, "The model fixture must receive the audit refusal before correction");
  } else assert.deepEqual(errors, [], JSON.stringify(errors));
  const { goal } = await host.call("goals.get", { sessionId: session.id });
  const expectedStatus = completing ? "completed" : scenario === "pause" ? "paused" : "budget_exhausted";
  assert.equal(goal.status, expectedStatus); assert.equal(goal.roundsStarted, expectedTurns);
  assert(!goal.activeTurnId);
  assert.deepEqual(goal.budget, expectedBudget);
  if (completing) assert.deepEqual(goal.audit, validAudit);
  if (scenario === "audit-recovery") assert(correctedToolError);
  await host.call("settings.set", { defaultGoalBudget: { maxTurns: 7, maxTokens: 100 } });
  assert.deepEqual((await host.call("goals.get", { sessionId: session.id })).goal.budget, expectedBudget, "Settings never widen or replace an existing budget");
  assert.equal(requests.length, expectedRequests);
  await agentHost.kick(session.id); await agentHost.kick(session.id);
  assert.equal(requests.length, expectedRequests, "No extra turn after a stopping boundary");
  assert.equal((await host.call("plans.pending", { sessionId: session.id })).plans.length, 0);
  const detail = (await host.call("session.get", { id: session.id })).session;
  assert.equal(detail.messages.filter(message => message.role === "user").length, 1, "Internal continuations must not impersonate user input");
  assert(goalEvents.some(event => event.goal?.roundsStarted === 1 && event.goal?.status === "active"));
  const { session: recovery } = await host.call("session.create", { title: "Recovery fixture", projectPath: workspace, mode: "goal" });
  const recoveryGoal = (await host.call("goals.start", { sessionId: recovery.id, objective: "Do not replay after restart" })).goal;
  await host.call("goals.claimTurn", { sessionId: recovery.id, goalId: recoveryGoal.id, expectedRevision: recoveryGoal.revision, turnId: randomUUID() });
  await runtime.dispose(); runtime = undefined;
  await sidecar.dispose(); sidecar = undefined;
  await host.dispose(); host = openHost();
  await host.handshake();
  const restored = (await host.call("goals.get", { sessionId: recovery.id })).goal;
  assert.equal(restored.status, "paused"); assert(!restored.activeTurnId); assert.equal(restored.roundsStarted, 1);
  assert.equal((await host.call("goals.get", { sessionId: session.id })).goal.status, expectedStatus);
  console.log(JSON.stringify({ result: "PASS", scenario, finalStatus: goal.status, goalTurns: goal.roundsStarted, modelRequests: requests.length,
    userMessages: 1, noUnexpectedContinuation: true, correctedToolError, expectedToolValidationErrors: errors.length, budget: goal.budget, auditAccepted: Boolean(goal.audit), restartStatus: restored.status, tokenUsage: goal.tokenUsage }, null, 2));
} finally {
  clearTimeout(timeout);
  releaseResponse();
  await runtime?.dispose(); await sidecar?.dispose(); await host?.dispose();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
