#!/usr/bin/env node
// Real Rust + sidecar + AgentHost user paths. Only the model is a loopback fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentHost } from "../packages/agent-host/dist/index.js";
import { AgentSidecar, HostProcess, RuntimeService, GoalCoordinator, createHostSessionPort, createHostQueueStore } from "../packages/host-runtime/dist/index.js";
assert(process.env.PI_HOST_CORE_BINARY && process.env.PI_SCRATCH_DIR);
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "goal-removal-rounds-e2e-"));
const data = join(root, "data"), home = join(root, "home"), workspace = join(root, "workspace");
for (const p of [data, home, workspace]) await mkdir(p, { recursive: true });
const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PI_DESKTOP_DATA_DIR: data };
const requests = [], responses = [], errors = [], ended = []; let fixtureError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions"); let body = "";
    for await (const chunk of req) { body += chunk; assert(body.length < 2_000_000); }
    requests.push(JSON.parse(body)); assert(requests.length <= 16, "Unexpected autonomous request");
    responses.push(res); res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
  } catch (error) { fixtureError = error; res.writeHead(500); res.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const owner = { subject: "fixture", roles: ["owner"], pairedDevice: true };
let host, sidecar, runtime, agentHost;
const wait = async (read, label) => {
  const end = Date.now() + 25000;
  while (Date.now() < end) { if (fixtureError) throw fixtureError; const result = await read(); if (result) return result; await delay(25); }
  throw Error(`Timeout ${label}: requests=${requests.length}, errors=${JSON.stringify(errors)}`);
};
const answer = (index, tool, args = {}, tokens = 11, text = "Fixture round finished.") => {
  const res = responses[index]; assert(res && !res.destroyed);
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
    : { role: "assistant", content: text };
  for (const [value, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: `fixture-${index}`, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens } })}\n\n`);
  res.end("data: [DONE]\n\n");
};
const system = index => requests[index].messages.filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
const get = async id => (await host.call("goals.get", { sessionId: id })).goal;
const control = async (id, action, extra = {}) => {
  const goal = await get(id);
  return agentHost.controlGoal(owner, { sessionId: id, goalId: goal.id, expectedRevision: goal.revision, action, ...extra });
};
const start = (id, text, key) => agentHost.startGoal(owner, { sessionId: id, admission: "queue", input: { text, userMessageId: randomUUID() }, context: { requestId: key } });
try {
  host = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: data, env, onStderr() {} });
  await host.handshake(); await host.call("workspace.set", { path: workspace });
  const { session } = await host.call("session.create", { title: "Independent Goal fixture", projectPath: workspace, mode: "goal" });
  sidecar = new AgentSidecar({ launch: { command: process.execPath, args: [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], cwd: workspace, env: { ...process.env, ...env } }, onStderr() {} });
  sidecar.setHost(host);
  const goals = new GoalCoordinator(() => host), commandShell = (await host.call("commandShells.list")).effective;
  runtime = new RuntimeService({ getHost: () => host, getSidecar: () => sidecar, pauseGoal: id => agentHost.pauseGoal(id),
    log: (level, message, data) => { if (level === "error") errors.push({ message, data }); },
    launch: { async resolve(sessionId) { return { providerId: "fixture", modelId: "fixture", projectPath: workspace,
      sidecarParams: { sessionId, commandShell, mode: "agent", projectPath: workspace, scratchDir: join(root, "scratch"), thinkingLevel: "off", provider: { id: "fixture", name: "Loopback fixture", modelId: "fixture", baseUrl, apiStyle: "chat_completions", apiKey: "local-fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"], modelConfig: { source: "generic", name: "Fixture", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 } } } }; } } });
  agentHost = new AgentHost({ runtime, goals, sessions: createHostSessionPort(() => host), queueStore: createHostQueueStore(() => host),
    approvals: { async resolveTool() {}, async resolveContract() { throw Error("Unexpected approval"); }, async listPendingTools() { return []; } } });
  runtime.attachHost(host); runtime.attachSidecar(sidecar); runtime.onEvent(event => agentHost.ingest(event));
  runtime.onTurnEnded(info => { ended.push(info); agentHost.endTurn(info.sessionId, info.turnId, info.reason === "completed" ? "completed" : "failed"); void agentHost.kick(info.sessionId); });
  await agentHost.start();
  await host.call("session.configure", { id: session.id, mode: "goal", permissionMode: "auto" });
  const initial = await start(session.id, "Finish the current conversation even after removing its Goal", "remove-current");
  await wait(() => requests.length === 1, "held Goal response");
  const old = await get(session.id);
  assert.equal(old.roundsStarted, 1); assert.equal(old.roundsCompleted, 0);
  await control(session.id, "delete");
  assert.equal(await get(session.id), null);
  assert.equal((await host.call("session.get", { id: session.id })).session.mode, "agent");
  assert.equal((await agentHost.workSnapshot(session.id)).state, "running");
  answer(0, "Write", { path: "removed-goal.txt", content: "Goal removal kept this conversation running." });
  await wait(() => requests.length === 2, "native Write after Goal removal");
  assert(system(1).includes("The user removed the Goal"));
  answer(1); await wait(() => ended.length === 1, "removed Goal conversation ends normally");
  assert.equal(ended[0].reason, "completed");
  assert.equal(ended[0].turnId, initial.turn.id);
  assert.equal(await readFile(join(workspace, "removed-goal.txt"), "utf8"), "Goal removal kept this conversation running.");
  await agentHost.kick(session.id); assert.equal(requests.length, 2);

  // A paused Goal is independent from ordinary Agent and Plan execution.
  for (const mode of ["agent", "plan"]) {
    const started = (await host.call("goals.start", { sessionId: session.id, objective: "Paused independent objective" })).goal;
    await agentHost.controlGoal(owner, { sessionId: session.id, goalId: started.id, expectedRevision: started.revision, action: "pause" });
    await host.call("session.configure", { id: session.id, mode, permissionMode: "auto" });
    const index = requests.length, previousEnds = ended.length;
    const current = await agentHost.startTurn(owner, { sessionId: session.id, input: { text: `Ordinary ${mode} work` }, context: { requestId: `ordinary-${mode}` } });
    await wait(() => requests.length === index + 1, `held ordinary ${mode} response`);
    await control(session.id, "delete");
    assert.equal((await agentHost.workSnapshot(session.id)).state, "running");
    assert.equal((await host.call("session.get", { id: session.id })).session.mode, "agent");
    assert.equal((await host.call("session.getTurnMode", { sessionId: session.id, turnId: current.turn.id })).mode, mode);
    answer(index, "Read", { path: "removed-goal.txt" });
    await wait(() => requests.length === index + 2, `ordinary ${mode} tool result`);
    assert(!system(index + 1).includes("<untrusted-goal-data>"));
    answer(index + 1); await wait(() => ended.length === previousEnds + 1, `ordinary ${mode} ends`);
    assert.equal(ended.at(-1).turnId, current.turn.id); assert.equal(ended.at(-1).reason, "completed");
    await agentHost.kick(session.id); assert.equal(requests.length, index + 2);
  }

  // Force two actual context rollovers inside a single Host conversation.
  await host.call("settings.set", { defaultGoalBudget: { maxTurns: 1 } });
  const { session: compactSession } = await host.call("session.create", { title: "Completed rounds fixture", projectPath: workspace, mode: "goal" });
  await host.call("session.configure", { id: compactSession.id, mode: "agent", permissionMode: "auto" });
  const index = requests.length, previousEnds = ended.length;
  const compactions = []; const unsubscribe = runtime.onEvent(envelope => {
    if (envelope.sessionId === compactSession.id && envelope.event.type === "compaction_end" && envelope.event.ok) compactions.push(envelope);
  });
  await start(compactSession.id, "Read the fixture and finish exactly one conversation", "count-rounds");
  let cursor = index;
  for (let offset = 0; offset < 2; offset++) {
    await wait(() => requests.length === cursor + 1, `Agent request before context compaction ${offset}`);
    const current = await get(compactSession.id);
    assert.equal(current.roundsStarted, 1); assert.equal(current.roundsCompleted, 0);
    answer(cursor++, "Read", { path: "removed-goal.txt" }, 80000);
    await wait(() => requests.length === cursor + 1, `summary request ${offset}`);
    assert.equal(requests[cursor].tools?.length ?? 0, 0, "summary generation has no action tools");
    assert.match(JSON.stringify(requests[cursor].messages), /summary|summariz|checkpoint/i);
    assert.equal((await get(compactSession.id)).roundsCompleted, 0);
    answer(cursor++, undefined, {}, 11, `## Goal
Read the fixture and finish this same conversation.
## Progress
The fixture was read.
## Next Steps
Finish the current task; do not start a new Host conversation.`);
  }
  await wait(() => requests.length === cursor + 1, "final Agent response after two compactions");
  await wait(() => compactions.length === 2, "second persisted compaction event");
  assert.equal(compactions.length, 2);
  assert.equal((await get(compactSession.id)).roundsCompleted, 0);
  answer(cursor); await wait(() => ended.length === previousEnds + 1, "one complete Host conversation");
  const counted = await get(compactSession.id);
  assert.equal(counted.roundsStarted, 1); assert.equal(counted.roundsCompleted, 1);
  assert.equal(counted.status, "budget_exhausted");
  await agentHost.kick(compactSession.id); assert.equal(requests.length, index + 5); unsubscribe();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", modelRequests: requests.length, removedCurrentGoalFinishes: true,
    unrelatedAgentAndPlanContinue: true, inputReturnsToAgent: true, frozenPlanPolicyPreserved: true,
    noAutonomousNextRound: true, realCompactions: compactions.length, compactionSummaryRequests: 2, agentRequestsInCountedConversation: 3, countedCompletedConversations: counted.roundsCompleted,
    errorAbortRecoveryAndForeignFences: "covered by Rust and runtime regressions" }, null, 2));
} finally {
  await runtime?.dispose(); await sidecar?.dispose(); await host?.dispose();
  for (const res of responses) res.destroy(); await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
