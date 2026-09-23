#!/usr/bin/env node
/** Isolated real Host + production Main service/sidecar + local SSE provider.
 * The external worker wait is a controlled local-tool boundary, not a model
 * or a live user's session. No Electron UI or paid provider is used.
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { loadDevelopmentPlugin } from "./e2e/plugin.mjs";
import { AgentSidecar } from "../packages/host-runtime/dist/index.js";

const requireDesktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = requireDesktop("typescript");
function load(path, imports) {
  const file = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}
const models = load("../apps/desktop/electron/main/plugin-agent-complete.ts", {
  "@pi-desktop/agent-runtime": await import("../packages/agent-runtime/dist/index.js"),
  "@pi-desktop/shared": await import("../packages/shared/dist/index.js"),
});
const { createSessionCollaborationService } = load("../apps/desktop/electron/main/services/session-collaboration.ts", {
  "node:crypto": crypto, "../agent-host-bridge": { DESKTOP_PRINCIPAL: { kind: "desktop" } },
  "../plugin-agent-complete": models,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 25_000);
    })]);
  } finally { clearTimeout(timer); }
}
const dir = mkdtempSync(join(tmpdir(), "pi-current-turn-e2e-"));
const host = new Host(resolveHostBinary(), dir);
const requests = [];
const toolName = "plugin_e2e_current_turn_wait";
const pluginId = "e2e.current-turn";
const entered = deferred();
const release = deferred();
const ended = deferred();
const events = [];
let outbox = Promise.resolve();
let sidecar;
let runtimeStderr = "";
const active = new Map();
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  // Follow the actual ToolSearch activation contract; deferred plugin tools
  // cannot execute until they are exposed on the following model request.
  const toolCall = requests.length === 1
    ? { name: "ToolSearch", arguments: JSON.stringify({ query: toolName }) }
    : requests.length === 2 ? { name: toolName, arguments: "{}" } : undefined;
  const delta = toolCall ? {
    role: "assistant", content: "Waiting for worker09.",
    tool_calls: [{ index: 0, id: `wait09-${requests.length}`, type: "function", function: toolCall }],
  } : { role: "assistant", content: "Used worker08's result while worker09 continues." };
  const base = { id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: payload.model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
const ui = (role, content) => ({ id: crypto.randomUUID(), role, content, status: "complete", createdAt: new Date().toISOString() });
async function session(title) {
  return (await host.call("session.create", { title, mode: "agent", projectPath: process.cwd() })).session.id;
}
async function begin(sessionId, messageId) {
  const { turnId } = await host.call("session.beginTurn", { sessionId, ...(messageId ? { sessionMessageId: messageId } : {}) });
  active.set(sessionId, turnId);
  return turnId;
}
try {
  await host.start(11);
  await host.call("settings.set", { sessionMessagesInCurrentTurn: true });
  const pluginPath = join(dir, "fixture-plugin");
  mkdirSync(pluginPath);
  writeFileSync(join(pluginPath, "main.js"), "module.exports = { onLoad() {} };\n");
  writeFileSync(join(pluginPath, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: pluginId, name: "Current-turn fixture", version: "0.1.0", main: "main.js",
    contributes: { agentTools: [{ name: "wait", description: "Await the next worker status interval.", risk: "low", schema: { type: "object", properties: {} } }] },
    permissions: ["agent.tool.register"],
  }));
  await loadDevelopmentPlugin(host, pluginPath);
  const parent = await session("Parent");
  const worker08 = await session("Worker08");
  const worker09 = await session("Worker09");
  const parentTurn = await begin(parent);
  const worker09Turn = await begin(worker09);
  const task = (await host.call("session.collaboration.send", {
    sourceSessionId: parent, sourceTurnId: parentTurn, pluginId, sessionId: worker08,
    kind: "task", content: "Produce report08", idempotencyKey: "task08", notifyOnCompletion: true,
  })).message;
  const worker08Turn = await begin(worker08, task.id);
  await host.call("session.appendMessage", { sessionId: worker08, turnId: worker08Turn, message: ui("user", task.content) });
  const initial = ui("user", "Coordinate workers08 and09. Use completed results without stopping ongoing workers.");
  await host.call("session.appendMessage", { sessionId: parent, turnId: parentTurn, message: initial });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))] },
    onStderr: (text) => { runtimeStderr += text; },
  });
  sidecar.setHost({
    call: host.call.bind(host),
    onNotification: () => () => {},
    onExit: (handler) => { host.child.on("exit", handler); return () => host.child?.off("exit", handler); },
  });
  let waitAborted = false;
  sidecar.setLocalTool(toolName, async ({ signal }) => {
    const onAbort = () => { waitAborted = true; };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      entered.resolve();
      await release.promise;
      return { ok: true, content: "Worker09 is still running; its status-poll interval ended.", isError: false };
    } finally {
      // AgentSidecar aborts its controller during normal cleanup as well.
      // Count only an interruption while this tool was still executing.
      signal.removeEventListener("abort", onAbort);
    }
  });
  let queuedTurns = 0;
  const service = createSessionCollaborationService({
    getHost: () => host, getSidecar: () => sidecar, getActiveTurn: (id) => active.get(id),
    getBridge: () => ({ queue: { list: () => [] }, agentHost: { startTurn: async () => { queuedTurns += 1; throw new Error("Unexpected next-turn delivery"); } } }),
    flushTranscript: async () => { await outbox; return true; },
    isPluginLoaded: (id) => id === pluginId, isQuitting: () => false, onChanged: () => {},
    log: (message, data) => console.error(message, data),
  });
  sidecar.setSessionMessageReceiver((params) => service.receive(params));
  sidecar.onNotification((method, envelope) => {
    if (method !== "agent.event") return;
    events.push(envelope);
    if (envelope.event.type === "message_end") {
      outbox = outbox.then(() => host.call("session.appendMessage", {
        sessionId: envelope.sessionId, turnId: envelope.turnId, message: envelope.event.message,
      }));
      // Keep rejection observable at flush/end, without an unhandled-rejection race.
      void outbox.catch(() => {});
    }
    if (envelope.event.type === "agent_end") ended.resolve();
  });
  await sidecar.call("agent.prompt", {
    sessionId: parent, turnId: parentTurn, userMessageId: initial.id, content: initial.content,
    mode: "agent", sessionMessagesInCurrentTurn: true, thinkingLevel: "off", projectPath: process.cwd(),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "", authKind: "none", apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    pluginTools: [{ name: toolName, description: "Await worker09's status interval.", parameters: { type: "object", properties: {} }, risk: "low" }],
  });
  await bounded(entered.promise, "parent waiting for09");
  const send = () => service.invoke({
    source: "plugin", operation: "session/collaboration/send",
    pluginContext: { pluginId, sessionId: worker08, turnId: worker08Turn, invocationId: "send08" },
    args: [{ sessionId: parent, kind: "message", content: "Report08 is ready.", idempotencyKey: "report08", notifyOnCompletion: false }],
  });
  const delivery = await send();
  assert.deepEqual(await send(), delivery, "retry returns the same durable offered message");
  await host.call("session.appendMessage", { sessionId: worker08, turnId: worker08Turn, message: ui("assistant", "Report08 is complete.") });
  await host.call("session.endTurn", { turnId: worker08Turn, status: "completed", createNotification: false });
  const { callback } = await host.call("session.collaboration.settle", { turnId: worker08Turn });
  active.delete(worker08);
  await service.drain();
  assert.equal(requests.length, 2, "arrival neither interrupts nor starts a model request inside the running tool");
  assert.equal(queuedTurns, 0);
  assert.equal(waitAborted, false);
  assert.equal(callback.kind, "completion");
  release.resolve();
  await bounded(ended.promise, "parent safe request and completion");
  await outbox;
  assert.deepEqual(events.filter((e) => e.event.type === "error"), [], runtimeStderr);
  assert.equal(requests.length, 3, JSON.stringify(requests));
  const secondInputs = requests[2].messages.filter((m) => m.role === "user");
  for (const messageId of [delivery.messageId, callback.id]) {
    assert.equal(secondInputs.filter((m) => JSON.stringify(m.content).includes(messageId)).length, 1, "each source ID occurs in one actual next-request input");
    const { message } = await host.call("session.collaboration.message", { messageId });
    assert.equal(message.turnId, parentTurn);
    assert.equal(message.currentTurn.state, "accepted");
  }
  assert.ok(events.every((e) => !e.turnId || e.turnId === parentTurn), "no replacement parent turn");
  assert.equal((await host.call("session.collaboration.status", { sessionId: worker09 })).status, "running");
  assert.equal(active.get(worker09), worker09Turn);
  assert.equal(waitAborted, false);
  await host.call("session.endTurn", { turnId: parentTurn, status: "completed", createNotification: false });
  active.delete(parent);
  await service.settle(parent, parentTurn);
  assert.equal(queuedTurns, 0, "accepted messages are not replayed as a later prompt");
  assert.equal((await host.call("session.collaboration.pending", { sessionId: parent })).messages.length, 0);
  console.log("PASS E2E-SESSION-current-turn-collaboration: canonical message and completion received once in the same parent turn; worker09 unaffected");
} catch (error) {
  console.error("Current-turn fixture failure", {
    requests: requests.length, events: events.map((e) => e.event), runtimeStderr,
  });
  throw error;
} finally {
  release.resolve();
  await sidecar?.dispose();
  await host.stop();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
