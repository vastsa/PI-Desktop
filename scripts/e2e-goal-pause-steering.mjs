#!/usr/bin/env node
// Real Rust + sidecar + AgentHost user paths. Only the model is a loopback fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentHost } from "../packages/agent-host/dist/index.js";
import { AgentSidecar, HostProcess, RuntimeService, GoalCoordinator, createHostSessionPort, createHostQueueStore } from "../packages/host-runtime/dist/index.js";
assert(process.env.PI_HOST_CORE_BINARY && process.env.PI_SCRATCH_DIR);
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "goal-independent-e2e-"));
const data = join(root, "data"), home = join(root, "home"), workspace = join(root, "workspace");
for (const p of [data, home, workspace, join(root, "agents")]) await mkdir(p, { recursive: true });
await writeFile(join(workspace, "resume.txt"), "resumed offline fixture evidence", "utf8");
const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_AGENTS_DIR: join(root, "agents") };
const requests = [], responses = [], errors = []; let fixtureError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions"); let body = "";
    for await (const chunk of req) { body += chunk; assert(body.length < 2_000_000); }
    requests.push(JSON.parse(body)); assert(requests.length <= 11, "Unexpected autonomous request");
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
const answer = (index, tool, args = {}) => {
  const res = responses[index]; assert(res && !res.destroyed);
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
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
  await start(session.id, "Original objective", "initial");
  await wait(() => requests.length === 1, "initial Goal request");
  const first = await get(session.id);
  await agentHost.enqueueTurn(owner, { sessionId: session.id, input: { text: "Ordinary FIFO information" }, context: { requestId: "ordinary-fifo" } });
  assert.equal(requests.length, 1); assert.equal((await get(session.id)).activeTurnId, first.activeTurnId);
  answer(0); await wait(() => requests.length === 2, "FIFO starts after current Goal round, before Goal completion");
  assert.equal((await get(session.id)).status, "active");
  assert.equal((await get(session.id)).roundsStarted, 1);
  assert(!system(1).includes("<untrusted-goal-data>"));
  assert(JSON.stringify(requests[1].messages).includes("Ordinary FIFO information"));
  answer(1); await wait(() => requests.length === 3, "Goal continues after FIFO information");
  const live = await get(session.id); assert.equal(live.roundsStarted, 2);
  await control(session.id, "pause");
  let paused = await get(session.id);
  assert.equal(paused.status, "paused"); assert.equal(paused.pauseRequested, true);
  assert.equal(paused.activeTurnId, live.activeTurnId);
  await assert.rejects(control(session.id, "resume"), /GOAL_TURN_IN_FLIGHT|in.flight/i);
  answer(2); await wait(() => requests.length === 4, "pause notice reaches next provider boundary");
  assert(system(3).includes("Goal paused by the user"));
  answer(3);
  await wait(async () => { const row = await get(session.id); return row.status === "paused" && !row.activeTurnId; }, "brief handoff ends");
  await agentHost.kick(session.id); assert.equal(requests.length, 4);
  const detail = (await host.call("session.get", { id: session.id })).session;
  const users = detail.messages.filter(message => message.role === "user").map(message => message.content);
  assert.deepEqual(users, ["Original objective", "Ordinary FIFO information"]);
  await wait(async () => (await agentHost.workSnapshot(session.id)).state === "idle", "first runtime idle");
  await control(session.id, "resume");
  await wait(() => requests.length === 5, "explicit resume dispatches a fresh claim");
  assert.equal((await get(session.id)).status, "active");
  assert(!system(4).includes("Goal paused by the user"), "Expired pause control reached the resumed request");
  answer(4, "Read", { path: "resume.txt" });
  await wait(() => requests.length === 6, "resumed native Read finishes");
  assert(JSON.stringify(requests[5].messages.filter(message => message.role === "tool")).includes("resumed offline fixture evidence"));
  assert(!system(5).includes("Goal paused by the user"));
  await control(session.id, "pause"); answer(5);
  await wait(() => requests.length === 7, "resumed claim still obeys a new Pause");
  assert(system(6).includes("Goal paused by the user")); answer(6);
  await wait(async () => { const row = await get(session.id); return row.status === "paused" && !row.activeTurnId; }, "resumed handoff settles");
  await wait(async () => (await agentHost.workSnapshot(session.id)).state === "idle", "resumed runtime idle");
  await start(session.id, "Uncooperative closeout fixture", "bounded");
  await wait(() => requests.length === 8, "second Goal begins");
  assert(!system(7).includes("Goal paused by the user"), "Replaced Goal inherited an old pause");
  await control(session.id, "pause"); answer(7, "GetGoal");
  for (let index = 8; index < 11; index++) {
    await wait(() => requests.length === index + 1, "bounded closeout request " + index);
    assert(system(index).includes("Goal paused by the user")); answer(index, "GetGoal");
  }
  await wait(async () => { const row = await get(session.id); return row.status === "paused" && !row.activeTurnId; }, "runtime ends uncooperative model at three-request limit");
  await agentHost.kick(session.id); assert.equal(requests.length, 11);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", modelRequests: requests.length, fifoAfterCurrentRoundNotCompletion: true,
    fifoBeforeGoalContinuation: true, immediateDurablePause: true, cooperativeHandoffRequests: 1,
    uncooperativeHandoffRequests: 3, noFakeUserMessages: true, noAutomaticResume: true,
    explicitResumeExpiresPause: true, resumedNativeRead: true, replacementExpiresPause: true }, null, 2));

} finally {
  await runtime?.dispose(); await sidecar?.dispose(); await host?.dispose();
  for (const res of responses) res.destroy(); await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
