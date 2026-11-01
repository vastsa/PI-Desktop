#!/usr/bin/env node
// Real Rust + sidecar + AgentHost user paths. Only the model is a loopback fixture.
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
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "goal-independent-e2e-"));
const data = join(root, "data"), home = join(root, "home"), workspace = join(root, "workspace");
for (const p of [data, home, workspace]) await mkdir(p, { recursive: true });
const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PI_DESKTOP_DATA_DIR: data };
const requests = [], responses = [], errors = []; let fixtureError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions"); let body = "";
    for await (const chunk of req) { body += chunk; assert(body.length < 2_000_000); }
    requests.push(JSON.parse(body)); assert(requests.length <= 9, "Unexpected autonomous request");
    if (requests.length === 9) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Fixture insufficient balance", type: "insufficient_quota", code: "insufficient_quota" } }));
      return;
    }
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
const answer = (index, tool) => {
  const res = responses[index]; assert(res && !res.destroyed);
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: tool, arguments: "{}" } }] }
    : { role: "assistant", content: "Fixture round finished." };
  for (const [value, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: `fixture-${index}`, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
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
      sidecarParams: { sessionId, commandShell, mode: "agent", projectPath: workspace, scratchDir: join(root, "scratch"), thinkingLevel: "off", provider: { id: "fixture", name: "Loopback fixture", modelId: "fixture", baseUrl, apiStyle: "chat_completions", apiKey: "local-fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] } } }; } } });
  agentHost = new AgentHost({ runtime, goals, sessions: createHostSessionPort(() => host), queueStore: createHostQueueStore(() => host),
    approvals: { async resolveTool() {}, async resolveContract() { throw Error("Unexpected approval"); }, async listPendingTools() { return []; } } });
  runtime.attachHost(host); runtime.attachSidecar(sidecar); runtime.onEvent(event => agentHost.ingest(event));
  runtime.onTurnEnded(info => { agentHost.endTurn(info.sessionId, info.turnId, info.reason === "completed" ? "completed" : "failed"); void agentHost.kick(info.sessionId); });
  await agentHost.start();
  const first = await start(session.id, "Original objective", "first");
  await wait(() => requests.length === 1, "first request"); const initial = await get(session.id);
  assert.equal((await host.call("session.get", { id: session.id })).session.mode, "agent", "one-shot persisted mode");
  for (const mode of ["plan", "goal", "agent"]) {
    await host.call("session.configure", { id: session.id, mode });
    const row = await get(session.id); assert.equal(row.status, "active"); assert.equal(row.activeTurnId, initial.activeTurnId);
    assert.equal((await host.call("session.getTurnMode", { sessionId: session.id, turnId: first.turn.id })).mode, "goal");
  }
  await control(session.id, "edit", { objective: "Revised next-round objective" });
  let goal = await get(session.id); assert.equal(goal.objective, "Revised next-round objective");
  assert.equal(goal.activeScope.objective, "Original objective"); assert.equal(goal.status, "active");
  await assert.rejects(host.call("goals.report", { sessionId: session.id, goalId: goal.id, turnId: goal.activeTurnId, status: "completed", progressSummary: "Old scope checked", outcomes: [{ criterion: "Original objective", outcome: "met", evidence: "Fixture" }], audit: { version: 1, objective: "Original objective", items: [{ requirement: "Original objective", outcome: "met", evidence: "Fixture" }], remainingWork: [] } }), /GOAL_COMPLETION_UNVERIFIED|changed|edited/i);
  const guidance = await agentHost.enqueueTurn(owner, { sessionId: session.id, input: { text: "Additional guidance from the user" }, context: { requestId: "guidance" } });
  await agentHost.prioritizeTurn(owner, guidance.turn.id);
  assert.equal((await get(session.id)).activeTurnId, initial.activeTurnId); assert(!responses[0].destroyed);
  answer(0, "GetGoal"); await wait(() => requests.length === 2, "same-round provider follow-up");
  assert(system(1).includes('"objective":"Original objective"')); assert(!system(1).includes('"objective":"Revised next-round objective"'));
  assert(JSON.stringify(requests[1].messages.filter(message => message.role === "user")).includes("Additional guidance from the user"));
  await agentHost.enqueueTurn(owner, { sessionId: session.id, input: { text: "Ordinary queued follow-up" }, context: { requestId: "queued-follow-up" } });
  assert.equal((await get(session.id)).activeTurnId, initial.activeTurnId);
  answer(1); await wait(() => requests.length === 3, "ordinary FIFO message runs before continuation");
  assert(!system(2).includes("<untrusted-goal-data>"));
  assert.equal((await get(session.id)).status, "active");
  answer(2); await wait(() => requests.length === 4, "automatic next Host round");
  assert(system(3).includes('"objective":"Revised next-round objective"'));
  goal = await get(session.id); assert.equal(goal.roundsStarted, 2); assert.equal(goal.status, "active");
  await control(session.id, "pause"); assert.equal((await get(session.id)).status, "active"); answer(3);
  await wait(async () => { const row = await get(session.id); return row.status === "paused" && !row.activeTurnId; }, "manual finish-round pause");
  await wait(async () => (await agentHost.workSnapshot(session.id)).state === "idle", "paused runtime drains");
  await agentHost.startTurn(owner, { sessionId: session.id, input: { text: "Ordinary Agent task", userMessageId: randomUUID() }, context: { requestId: "ordinary" } });
  await wait(() => requests.length === 5, "ordinary Agent task"); assert(!system(4).includes("<untrusted-goal-data>")); answer(4);
  await wait(async () => (await agentHost.workSnapshot(session.id)).state === "idle", "ordinary task finishes");
  assert.equal((await get(session.id)).status, "paused"); await control(session.id, "resume");
  await wait(() => requests.length === 6, "resume from Agent mode");
  assert.equal((await get(session.id)).status, "active"); assert(system(5).includes('"objective":"Revised next-round objective"'));
  const oldId = (await get(session.id)).id;
  const replacement = await start(session.id, "Replacement objective", "replace-active"); assert.equal(replacement.accepted, true);
  await wait(() => requests.length === 7, "active replacement begins after old settlement");
  goal = await get(session.id); assert.notEqual(goal.id, oldId); assert.equal(goal.status, "active"); assert.equal(goal.roundsStarted, 1); assert.equal(goal.tokenUsage, 0);
  assert(system(6).includes('"objective":"Replacement objective"')); await control(session.id, "pause"); answer(6);
  await wait(async () => { const row = await get(session.id); return row.status === "paused" && !row.activeTurnId && (await agentHost.workSnapshot(session.id)).state === "idle"; }, "replacement pauses explicitly");
  const secondOldId = goal.id; await start(session.id, "Fresh objective replacing paused work", "replace-paused");
  await wait(() => requests.length === 8, "paused replacement starts without resume");
  goal = await get(session.id); assert.notEqual(goal.id, secondOldId); assert.equal(goal.roundsStarted, 1); assert.equal(goal.status, "active");
  await control(session.id, "stop"); await wait(async () => !(await get(session.id)).activeTurnId, "explicit Stop settles");
  assert.equal((await get(session.id)).status, "paused"); await agentHost.kick(session.id); assert.equal(requests.length, 8);
  const detail = (await host.call("session.get", { id: session.id })).session;
  const users = detail.messages.filter(message => message.role === "user").map(message => message.content);
  assert.deepEqual(users, ["Original objective", "Additional guidance from the user", "Ordinary queued follow-up", "Ordinary Agent task", "Replacement objective", "Fresh objective replacing paused work"]);
  assert.deepEqual(errors, []);
  const failed = (await host.call("session.create", { title: "Insufficient balance fixture", projectPath: workspace, mode: "agent" })).session;
  await start(failed.id, "Failure must stop safely", "provider-failure");
  await wait(async () => { const row = await get(failed.id); return row.status === "blocked" && !row.activeTurnId && (await agentHost.workSnapshot(failed.id)).state === "idle"; }, "provider inability blocks continuation");
  await agentHost.kick(failed.id); assert.equal(requests.length, 9);
  assert(errors.length > 0, "Provider failure remains observable");
  console.log(JSON.stringify({ result: "PASS", modelRequests: requests.length, realUserMessages: users.length, oneShotAgentMode: true, modeChangesNeverPause: true,
    editVisibleImmediately: true, scopeChangesNextHostRound: true, immediateGuidanceContinues: true, ordinaryQueuedMessageContinues: true, agentWorkThenResume: true,
    activeAndPausedReplacement: true, explicitPauseAndStopPreserved: true, providerFailureStopsSafely: true }, null, 2));
} finally {
  await runtime?.dispose(); await sidecar?.dispose(); await host?.dispose();
  for (const res of responses) res.destroy(); await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
