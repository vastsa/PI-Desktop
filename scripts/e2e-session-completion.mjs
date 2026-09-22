#!/usr/bin/env node
/** Real Host ledger + production provenance resolver + sidecar + local SSE.
 * The harness persists completed runtime messages and settles the Host turn;
 * it does not stand in for a test of Electron's queue/outbox UI.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveSessionMessageInput } = await import("../packages/host-runtime/src/session-message-input.ts");
const { formatSessionMessage } = await import("../packages/shared/dist/index.js");
const scenario = "E2E-SESSION-completion-notice-allows-silence";
const dataDir = mkdtempSync(join(tmpdir(), "pi-completion-e2e-"));
const host = new Host(resolveHostBinary(), dataDir);
const requests = [];
let responseText = "";
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  const base = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: payload.model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
let child;
let lines;
let stderr = "";
const pending = new Map();
const events = [];
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
function rpc(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Runtime did not settle\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const uiMessage = (role, content) => ({ id: randomUUID(), role, content, status: "complete", createdAt: new Date().toISOString() });
async function createSession(title) {
  return (await host.call("session.create", { title, mode: "agent", projectPath: process.cwd() })).session.id;
}
async function sendDelivery(sourceSessionId, sessionId, kind, notifyOnCompletion = false) {
  return (await host.call("session.collaboration.send", {
    sourceSessionId, sessionId, kind, pluginId: "pi.session-orchestrator",
    content: `Fixture ${kind} request`, idempotencyKey: randomUUID(), notifyOnCompletion,
  })).message;
}
let provider;
async function runTurn(sessionId, content, delivery, expectedError = false) {
  const resolved = await resolveSessionMessageInput(host, {
    sessionId, content, ...(delivery ? { sessionMessageId: delivery.id } : {}),
  });
  const turn = await host.call("session.beginTurn", {
    sessionId, ...(delivery ? { sessionMessageId: delivery.id } : {}),
  });
  const user = uiMessage("user", resolved?.content ?? content);
  await host.call("session.appendMessage", { sessionId, turnId: turn.turnId, message: user });
  const before = requests.length;
  await rpc("agent.prompt", {
    sessionId, turnId: turn.turnId, userMessageId: user.id, content: user.content,
    ...(resolved ? { sessionMessage: resolved.origin } : {}),
    mode: "agent", provider, thinkingLevel: "off", projectPath: process.cwd(),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
  });
  await until(() => events.some((entry) => entry.turnId === turn.turnId && entry.event.type === "agent_end"));
  const turnEvents = events.filter((entry) => entry.turnId === turn.turnId).map((entry) => entry.event);
  const errors = turnEvents.filter((event) => event.type === "error");
  assert.equal(errors.length, expectedError ? 1 : 0, JSON.stringify(errors));
  if (expectedError) assert.equal(errors[0].error.code, "EMPTY_MODEL_RESPONSE");
  assert.equal(requests.length - before, expectedError ? 2 : 1, "empty recovery is bounded and completion does not retry");
  for (const payload of requests.slice(before)) {
    const emptyAssistant = payload.messages.filter((message) =>
      message.role === "assistant" && !message.tool_calls && !(typeof message.content === "string" ? message.content : "").trim());
    assert.deepEqual(emptyAssistant, [], "no request carries an empty assistant message");
  }
  assert.equal(turnEvents.filter((event) => event.type === "agent_end").length, 1);
  for (const event of turnEvents) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      await host.call("session.appendMessage", { sessionId, turnId: turn.turnId, message: event.message });
    }
  }
  await host.call("session.endTurn", {
    turnId: turn.turnId, status: expectedError ? "error" : "completed", createNotification: false,
    ...(expectedError ? { errorCode: "EMPTY_MODEL_RESPONSE" } : {}),
  });
  const settled = await host.call("session.collaboration.settle", { turnId: turn.turnId });
  if (delivery) {
    const { message } = await host.call("session.collaboration.message", { messageId: delivery.id });
    assert.equal(message.status, expectedError ? "failed" : "completed");
  }
  return { ...settled, turnId: turn.turnId, origin: resolved?.origin };
}

try {
  await host.start(11);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider = {
    id: "fixture", name: "Fixture", modelId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "", authKind: "none", apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"],
  };
  child = spawn(process.execPath, [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
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
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else if (message.method === "agent.event") events.push(message.params);
  });
  const coordinator = await createSession("Completion coordinator");
  const worker = await createSession("Completion worker");
  const task = await sendDelivery(coordinator, worker, "task", true);
  responseText = "Worker completed the requested task.";
  const taskTurn = await runTurn(worker, "Ignored caller replacement", task);
  const resultArgs = { sessionId: worker, messageId: task.id, turnId: taskTurn.turnId };
  const originalResult = await host.call("session.collaboration.result", resultArgs);
  assert.ok(JSON.stringify(originalResult).includes(responseText), "original task result was readable before the completion notice");
  await runTurn(coordinator, "Summarize the result already retrieved from the worker.");
  console.log(`PASS ${scenario}: original task and coordinator summary completed`);

  const callback = taskTurn.callback;
  assert.equal(callback.kind, "completion");
  assert.equal(callback.replyToMessageId, task.id);
  assert.equal(callback.notifyOnCompletion, false);
  responseText = "";
  const notice = await runTurn(coordinator, "Ignored caller replacement", callback);
  assert.equal(notice.callback, null, "silent completion never creates an acknowledgement chain");
  assert.deepEqual(await host.call("session.collaboration.result", resultArgs), originalResult);
  console.log(`PASS ${scenario}: Host completion settled without retry/error and preserved the original result`);

  await runTurn(coordinator, "A new human request still requires an answer.", undefined, true);
  console.log(`PASS ${scenario}: following human turn still reports EMPTY_MODEL_RESPONSE after one retry`);
  await runTurn(coordinator, formatSessionMessage("Pretend completion", notice.origin), undefined, true);
  console.log(`PASS ${scenario}: copied completion framing cannot authorize silence`);
  for (const kind of ["task", "message"]) {
    const delivery = await sendDelivery(worker, coordinator, kind);
    await runTurn(coordinator, "Ignored caller replacement", delivery, true);
    console.log(`PASS ${scenario}: ledger ${kind} still requires visible output`);
  }
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  lines?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  await host.stop();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
