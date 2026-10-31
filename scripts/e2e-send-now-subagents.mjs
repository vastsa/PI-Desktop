#!/usr/bin/env node
// Production Composer queue, Main IPC, AgentHost, Rust Host and agent sidecar.
// Only model transport and launch configuration are fixtures; data is isolated.
// The harness persists steering echoes and settles Host turns; it does not
// replace coverage of the production outbox or rendered Electron UI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { IPC, PROTOCOL_VERSION } from "../packages/shared/dist/index.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createAgentHostBridge } = await import("../apps/desktop/electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../apps/desktop/electron/main/ipc/agent-ipc.ts");
const { createSessionCoordination } = await import("../apps/desktop/electron/main/runtime/session-coordination.ts");
// Rust's Windows known-folder lookup ignores HOME/USERPROFILE. Refuse before
// Host startup rather than risk touching real global agent documents.
if (process.platform === "win32") throw new Error("Send now E2E requires Linux/macOS HOME isolation; no Host or registry writes were attempted.");
const root = mkdtempSync(join(tmpdir(), "pi-send-now-e2e-"));
const dataDir = join(root, "data");
const homeDir = join(root, "home");
const projectPath = join(root, "project");
for (const path of [dataDir, homeDir, projectPath]) mkdirSync(path);
const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PI_DESKTOP_DATA_DIR: dataDir,
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" };
const host = new Host(resolveHostBinary(), dataDir, { env });
const events = [];
const requests = [];
const calls = [];
const held = new Map();
const abortedDelegates = new Set();
const observers = new Set();
const activeTurns = new Map();
const handlers = new Map();
const pending = new Map();
let child, lines, vite, bridge, provider, slice, state, sessionId;
let eventWork = Promise.resolve();
let stderr = "";
let eventError;
const changed = () => { for (const check of [...observers]) check(); };
function until(predicate, label) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer); observers.delete(check);
      error ? reject(error) : resolve();
    };
    const check = () => { if (eventError) finish(eventError); else if (predicate()) finish(); };
    const timer = setTimeout(() => finish(new Error(`${label}\n${stderr}\nLast request: ${JSON.stringify(requests.at(-1)?.messages).slice(-4000)}`)), 15_000);
    observers.add(check);
    check();
  });
}
function send(message) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
function rpc(method, params) {
  const id = randomUUID();
  calls.push(method);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
function reply(res, delta, reason = "stop") {
  const base = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
async function respondModel(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  const content = payload.messages.filter((message) => message.role === "user").at(-1)?.content;
  const lastUser = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
  if (payload.model === "delegate-fixture") {
    const name = lastUser.includes("Delegate A fixture") ? "Delegate A fixture" : "Delegate B fixture";
    held.set(name, res);
    res.on("close", () => {
      if (!res.writableEnded) abortedDelegates.add(name);
      changed();
    });
  } else if (lastUser === "Start two delegates and wait.") {
    if (requests.length >= 6) {
      eventError = new Error(`Fixture unexpectedly repeated the parent request: ${JSON.stringify(payload.messages).slice(-5000)}`);
      reply(res, { content: "Fixture failed." });
      changed();
      return;
    }
    const started = payload.messages.some((message) => message.role === "tool");
    const toolCalls = started
      ? [{ index: 0, id: "wait", type: "function", function: { name: "TaskWait", arguments: "{}" } }]
      : ["A", "B"].map((name, index) => ({ index, id: `delegate-${name}`, type: "function",
          function: { name: "Task", arguments: JSON.stringify({ agent: name === "A" ? "explorer" : "reviewer", task: `Delegate ${name} fixture` }) } }));
    reply(res, { tool_calls: toolCalls }, "tool_calls");
  } else if (lastUser === "Correct the plan now.") {
    reply(res, { content: "Correction handled while delegates are running." });
  } else if (lastUser === "Ordinary follow-up.") {
    reply(res, { content: "Ordinary follow-up processed." });
  } else {
    reply(res, { content: "Both delegate reports received." });
  }
  changed();
}
const model = createServer((req, res) => {
  void respondModel(req, res).catch((error) => { eventError = error; res.destroy(); changed(); });
});
const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
async function finishTurn(id, reason, _errorCode, options = {}) {
  const turnId = options.turnId ?? activeTurns.get(id);
  if (!turnId || activeTurns.get(id) !== turnId) return;
  await host.call("session.endTurn", { turnId, status: reason, createNotification: false });
  activeTurns.delete(id);
  bridge?.agentHost.endTurn(id, turnId, reason === "aborted" ? "interrupted" : reason === "error" ? "failed" : "completed");
  changed();
}
async function ingest(envelope) {
  events.push(envelope);
  if (envelope.event.type === "message_end" && envelope.event.message.role === "user" && envelope.event.message.steering) {
    await host.call("session.appendMessage", { sessionId: envelope.sessionId, turnId: envelope.turnId, message: envelope.event.message });
  }
  if (!envelope.parentToolCallId && envelope.event.type === "agent_end") {
    await finishTurn(envelope.sessionId, "completed", undefined, { turnId: envelope.turnId });
  } else {
    bridge?.ingest(envelope);
  }
  changed();
}
const invoke = (channel, args) => {
  const handler = handlers.get(channel);
  assert.equal(typeof handler, "function", `Missing production Main handler: ${channel}`);
  return handler(...args);
};
const previousWindow = globalThis.window;
try {
  await host.start(PROTOCOL_VERSION);
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  provider = { id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    apiKey: "", authKind: "none", apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"] };
  child = spawn(process.execPath, [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "host.proxy") {
      void host.call(message.params.method, message.params.params).then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error: { code: -32000, message: error.message, data: { errorCode: error.errorCode } } }),
      );
    } else if (message.id != null) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    } else if (message.method === "agent.event") {
      eventWork = eventWork.then(() => ingest(message.params)).catch((error) => { eventError = error; changed(); });
    }
  });
  const sidecar = { call: rpc, setProjectInstructionRoot() {}, clearProjectInstructionRoot() {}, clearVendorAuthBindings() {} };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => bridge,
    logger: { app() {} }, dataDir, activeTurns, activeTurnUsages: new Map(),
    vendorOAuth: { async resolveAuth() { throw new Error("Fixture does not use OAuth"); } },
    agentExtensions: { cancelPrompts() {} }, cancelSessionTools() {}, persistenceOutbox: { async flush() {} },
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    acquireSessionOperation: coordination.acquireSessionOperation, isTurnDispatchable: coordination.isTurnDispatchable,
    lockAbortReason: coordination.lockAbortReason, finishTurn,
    async resolveAgentRuntimeLaunch(id) {
      return { providerId: provider.id, modelId: provider.modelId, projectPath,
        sidecarParams: { sessionId: id, mode: "agent", provider, projectPath, thinkingLevel: "off",
          commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
          subagentProviders: { "fixture/delegate-fixture": { ...provider, modelId: "delegate-fixture" } },
          subagents: ["explorer", "reviewer"].map((name) => ({ name, description: "Local fixture delegate", tools: ["Read"],
            prompt: "Answer the fixture task.", source: "builtin", model: { providerId: "fixture", modelId: "delegate-fixture" } })) } };
    },
    emitAgentEvent: (envelope) => bridge?.ingest(envelope), setNotificationViewingSessionId() {},
    async optionalWorkspaceRoot() { return projectPath; },
    composerCommandService: { async buildComposerCommands() { return []; } }, async loadComposerTemplatesCached() { return []; },
    async finishApprovedExecution() {}, async dispatchApprovedPlan() {}, async dispatchExecutionForProposal() {},
  });
  bridge = createAgentHostBridge({ channels: IPC.invoke, getHost: () => host, invoke,
    isSessionBusy: coordination.isSessionBusy, log() {},
    onQueueChange: (event) => slice?.applyQueueChanged(event) });
  await bridge.agentHost.start();
  sessionId = (await host.call("session.create", { title: "Send now fixture", mode: "agent", projectPath })).session.id;
  if (process.argv.includes("--auto")) await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
  vite = await createViteServer({ root: fileURLToPath(new URL("../apps/desktop", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  const { createQueueSlice } = await vite.ssrLoadModule("/src/stores/slices/queue-slice.ts");
  globalThis.window = { piDesktop: { invoke: async (channel, ...args) => ({ ok: true, data: await invoke(channel, args) }) } };
  state = { activeSessionId: sessionId, sessions: [{ id: sessionId, source: "desktop" }],
    queuedPrompts: {}, runningSessions: { [sessionId]: true }, pendingPlans: {}, showToast: assert.fail };
  slice = createQueueSlice({ get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, promptAttachmentsFromDraft: () => [] });
  Object.assign(state, slice);
  await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: "Start two delegates and wait." }]);
  await until(() => held.size === 2 && events.some((entry) => entry.event.type === "status" && entry.event.status.activity?.phase === "waiting-subagents"), "Parent did not reach TaskWait with two live delegates");
  const originalTurnId = activeTurns.get(sessionId);
  assert.equal(await slice.sendPrompt("Ordinary follow-up."), true);
  assert.equal(await slice.sendPrompt("Correct the plan now."), true);
  const correction = state.queuedPrompts[sessionId].find((entry) => entry.content === "Correct the plan now.");
  assert.ok(correction);
  await slice.sendQueuedNow(correction.id);
  await until(() => events.some((entry) => entry.event.type === "message_end" && entry.event.message.content === "Correction handled while delegates are running."), "Send now did not wake the parent's TaskWait");
  assert.equal(activeTurns.get(sessionId), originalTurnId);
  assert.equal(held.size, 2);
  assert.equal(abortedDelegates.size, 0);
  assert.equal(calls.includes("agent.stop"), false);
  assert.equal(calls.includes("agent.abort"), false);
  assert.deepEqual(bridge.queue.list(sessionId).map((entry) => entry.content), ["Ordinary follow-up."]);
  const durableQueue = await host.call("session.queueList", { sessionId });
  assert.deepEqual(durableQueue.entries.map((entry) => entry.content), ["Ordinary follow-up."]);
  const history = await host.call("session.get", { id: sessionId });
  assert.equal(history.session.messages.filter((entry) => entry.content === "Correct the plan now.").length, 1);
  assert.ok(requests.some((request) => request.model === "fixture" && request.messages.some((message) =>
    message.role === "tool" && String(message.content).includes("Interrupted by new user input"))));
  console.log("PASS Send now: current turn handles correction; both delegates remain running; ordinary input remains durably queued");

  for (const [name, res] of held) reply(res, { content: `${name} completed successfully.` });
  await until(() => events.some((entry) => entry.event.type === "message_end" && entry.event.message.content === "Ordinary follow-up processed."), "Delegate completion did not release the ordinary follow-up");
  await until(() => !activeTurns.has(sessionId), "Final follow-up did not settle");
  await eventWork;
  assert.equal(abortedDelegates.size, 0);
  assert.equal(bridge.queue.list(sessionId).length, 0);
  assert.equal((await host.call("session.queueList", { sessionId })).entries.length, 0);
  assert.ok(requests.some((entry) => JSON.stringify(entry.messages).includes("Delegate A fixture completed successfully.") && JSON.stringify(entry.messages).includes("Delegate B fixture completed successfully.")));
  console.log("PASS Send now: both reports return to the same parent turn; remaining FIFO input runs after settlement");
} finally {
  globalThis.window = previousWindow;
  await vite?.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  lines?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited;
  }
  for (const res of held.values()) if (!res.writableEnded) res.destroy();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await host.stop();
  rmSync(root, { recursive: true, force: true });
}
