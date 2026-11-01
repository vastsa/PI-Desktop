#!/usr/bin/env node
// Real Host + sidecar boundaries; only the model endpoint is a local fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentHost } from "../packages/agent-host/dist/index.js";
import { AgentSidecar, HostProcess, RuntimeService, GoalCoordinator, createHostSessionPort, createHostQueueStore } from "../packages/host-runtime/dist/index.js";
assert(process.env.PI_HOST_CORE_BINARY && process.env.PI_SCRATCH_DIR);
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "goal-live-controls-"));
const data = join(root, "data"), home = join(root, "home"), workspace = join(root, "workspace");
for (const path of [data, home, workspace]) await mkdir(path, { recursive: true });
const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PI_DESKTOP_DATA_DIR: data };
const requests = [], held = [], errors = []; let fixtureError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions"); let text = "";
    for await (const chunk of req) { text += chunk; assert(text.length < 2000000); }
    requests.push(JSON.parse(text)); assert(requests.length <= 2, "Unexpected continuation");
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); held.push(res);
  } catch (error) { fixtureError = error; res.writeHead(500); res.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const owner = { subject: "fixture", roles: ["owner"], pairedDevice: true };
let host, sidecar, runtime, agentHost;
const wait = async (read, label) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (fixtureError) throw fixtureError; const result = await read(); if (result) return result; await delay(25); }
  throw Error(`Timeout: ${label}`);
};
const get = async id => (await host.call("goals.get", { sessionId: id })).goal;
const control = async (id, action, extra = {}) => {
  const goal = await get(id);
  return agentHost.controlGoal(owner, { sessionId: id, goalId: goal.id, expectedRevision: goal.revision, action, ...extra });
};
try {
  host = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: data, env, onStderr() {} });
  await host.handshake(); await host.call("workspace.set", { path: workspace });
  const { session } = await host.call("session.create", { title: "Live Goal control fixture", projectPath: workspace, mode: "goal" });
  sidecar = new AgentSidecar({ launch: { command: process.execPath, args: [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], cwd: workspace, env: { ...process.env, ...env } }, onStderr() {} });
  sidecar.setHost(host);
  const goals = new GoalCoordinator(() => host), commandShell = (await host.call("commandShells.list")).effective;
  runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, pauseGoal: id => agentHost.pauseGoal(id), log: (level, message) => { if (level === "error") errors.push(message); },
    launch: { async resolve(sessionId) { return { providerId: "fixture", modelId: "fixture", projectPath: workspace, sidecarParams: { sessionId, commandShell, mode: "goal", projectPath: workspace, scratchDir: join(root, "scratch"), thinkingLevel: "off", provider: { id: "fixture", name: "Loopback fixture", modelId: "fixture", baseUrl, apiStyle: "chat_completions", apiKey: "local-fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] } } }; } } });
  agentHost = new AgentHost({ runtime, goals, sessions: createHostSessionPort(() => host), queueStore: createHostQueueStore(() => host), approvals: { async resolveTool() {}, async resolveContract() { throw Error("Unexpected user approval"); }, async listPendingTools() { return []; } } });
  runtime.attachHost(host); runtime.attachSidecar(sidecar); runtime.onEvent(event => agentHost.ingest(event));
  runtime.onTurnEnded(info => { agentHost.endTurn(info.sessionId, info.turnId, info.reason === "completed" ? "completed" : "failed"); void agentHost.kick(info.sessionId); });
  await agentHost.start();
  await agentHost.startGoal(owner, { sessionId: session.id, input: { text: "Original fixture objective", userMessageId: randomUUID() }, context: { requestId: "live-start" }, budget: { maxTurns: 20 } });
  await wait(() => requests.length === 1, "first held model request");
  const initial = await get(session.id);
  await control(session.id, "edit", { objective: "Revised fixture objective" });
  let goal = await get(session.id);
  assert.equal(goal.status, "active"); assert.equal(goal.activeTurnId, initial.activeTurnId); assert.equal(goal.objective, "Revised fixture objective"); assert(!held[0].destroyed);
  await control(session.id, "budget", { budget: { maxTurns: 1, maxTokens: 500 } });
  goal = await get(session.id); assert.equal(goal.budget.maxTurns, 20); assert.equal(goal.pendingBudget.maxTurns, 1);
  await control(session.id, "pause");
  goal = await get(session.id); assert.equal(goal.status, "active"); assert.equal(goal.pauseRequested, true); assert.equal(goal.activeTurnId, initial.activeTurnId); assert(!held[0].destroyed);
  const reply = { id: "round-1", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Current round finished; the goal pauses now." }, finish_reason: null }] };
  held[0].write(`data: ${JSON.stringify(reply)}\n\n`);
  held[0].write(`data: ${JSON.stringify({ ...reply, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
  held[0].end("data: [DONE]\n\n");
  await wait(async () => { const row = await get(session.id); return !row.activeTurnId && row; }, "boundary pause settlement");
  goal = await get(session.id); assert.equal(goal.status, "paused"); assert.equal(goal.budget.maxTurns, 1); assert.equal(goal.pendingBudget, undefined); assert.equal(goal.tokenUsage, 11);
  await agentHost.kick(session.id); assert.equal(requests.length, 1);
  await control(session.id, "resume", { budget: { maxTurns: 4 } });
  await wait(() => requests.length === 2, "explicit resumed request");
  assert(JSON.stringify(requests[1]).includes("Revised fixture objective"));
  await control(session.id, "stop");
  await wait(async () => !(await get(session.id)).activeTurnId, "immediate stop settlement");
  assert.equal((await get(session.id)).status, "paused");
  await agentHost.kick(session.id); assert.equal(requests.length, 2);
  const detail = (await host.call("session.get", { id: session.id })).session;
  assert.equal(detail.messages.filter(message => message.role === "user").length, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", hotEditPreservesRound: true, budgetAppliedAtSettlement: true, pauseFinishesRound: true, stopInterrupts: true, noImplicitResume: true, modelRequests: requests.length, userMessages: 1 }, null, 2));
} finally {
  await runtime?.dispose(); await sidecar?.dispose(); await host?.dispose();
  for (const response of held) response.destroy(); await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
