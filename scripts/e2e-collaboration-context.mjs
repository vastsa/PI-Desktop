#!/usr/bin/env node
// Candidate Runtime -> pi -> loopback SSE, with real Host Todo and transcript
// persistence. All Host data, workspace files and HOME live in a temporary root.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

if (process.platform === "win32") throw new Error("This fixture requires HOME isolation on macOS/Linux.");
const hostBinary = resolveHostBinary();
const root = mkdtempSync(join(tmpdir(), "pi-collaboration-context-"));
const projectPath = join(root, "project");
const fixtureHome = join(root, "home");
mkdirSync(projectPath); mkdirSync(fixtureHome);
writeFileSync(join(projectPath, "evidence.txt"), "EVIDENCE_TOKEN: parser accepts the expected format.\n");
const host = new Host(hostBinary, join(root, "data"), { env: { HOME: fixtureHome }, quiet: true });
const requests = [];
const failures = [];
const state = { phase: "initial", step: 0, delegationId: undefined, trace: undefined };
function reply(res, body, tool, text = "Done.") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: body.model };
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    : { role: "assistant", content: text };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(structuredClone(body));
    if (body.model === "worker") {
      reply(res, body, body.messages.some((message) => message.role === "tool") ? undefined : { name: "Read", args: { path: "evidence.txt" } }, "Investigation finished; ask TaskList for the evidence.");
      return;
    }
    if (state.phase === "initial") {
      const tools = [
        { name: "ToolSearch", args: { query: "TodoWrite" } },
        { name: "TodoWrite", args: { todos: [{ content: "Verify the parser", status: "in_progress", priority: "high" }] } },
        { name: "Task", args: { agent: "explorer", task: "Read evidence.txt and report completion without quoting its contents." } },
        { name: "TaskWait", args: { delegationIds: [state.delegationId] } },
      ];
      reply(res, body, tools[state.step++]);
    } else if (state.phase === "inspect" && state.step++ === 0) {
      reply(res, body, { name: "TaskList", args: { delegationId: state.delegationId, query: "EVIDENCE_TOKEN", limit: 1 } });
    } else reply(res, body);
  } catch (error) {
    failures.push(error);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});
let runtime;
let sessionId;
let turnId;
let persistence = Promise.resolve();
const errors = [];
const toolResults = [];
const activeTools = new Map();
const provider = (modelId) => ({ id: "fixture", name: "Fixture", modelId,
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "", authKind: "none", apiStyle: "openai-chat",
  supportsReasoning: false, supportedThinkingLevels: ["off"] });
const runtimeFor = (history = [], compaction) => new DesktopAgentRuntime({
  host, sessionId, mode: "agent", provider: provider("parent"), thinkingLevel: "off", projectPath, history, compaction,
  compactionStrategy: "fresh_window",
  commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
  subagents: [{ name: "explorer", description: "Fixture explorer", prompt: "Read evidence.txt, then report completion without quoting evidence.",
    tools: ["Read"], source: "user", permission: "auto", model: { providerId: "fixture", modelId: "worker" } }],
  subagentProviders: { "fixture/worker": provider("worker") },
  onEvent: ({ event, parentToolCallId, agentName }) => {
    if (event.type === "error") errors.push(event.error);
    if (!parentToolCallId && event.type === "tool_end") {
      toolResults.push(event.result);
      if (event.result?.details?.delegationId) state.delegationId = event.result.details.delegationId;
      if (event.result?.details?.trace) state.trace = event.result.details.trace;
    }
    if (event.type === "tool_start") activeTools.set(event.toolCallId, {
      id: event.toolCallId, role: "tool", content: "", toolCallId: event.toolCallId,
      toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString(),
      ...(parentToolCallId ? { parentToolCallId, agentName } : {}),
    });
    if (event.type === "tool_end") {
      const message = { ...activeTools.get(event.toolCallId), toolResult: event.result,
        toolStatus: event.isError ? "error" : "success", isError: event.isError };
      activeTools.delete(event.toolCallId);
      persistence = persistence.then(() => host.call("session.appendMessage", { sessionId, turnId, message }));
    }
    if (event.type === "message_end") {
      const message = { ...event.message, ...(parentToolCallId ? { parentToolCallId, agentName } : {}) };
      persistence = persistence.then(() => host.call("session.appendMessage", { sessionId, turnId, message }));
    }
  },
});
async function run(text) {
  ({ turnId } = await host.call("session.beginTurn", { sessionId }));
  const user = { id: randomUUID(), role: "user", content: text, createdAt: new Date().toISOString() };
  await host.call("session.appendMessage", { sessionId, turnId, message: user });
  await runtime.prompt(text, user.id, turnId);
  await persistence;
  await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
}
try {
  await host.start();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  sessionId = (await host.call("session.create", { title: "Collaboration fixture", mode: "agent", projectPath })).session.id;
  runtime = runtimeFor();
  await run("Track parser verification and delegate the investigation.");
  const initialParent = requests.filter((request) => request.model === "parent");
  assert(initialParent.slice(2).every((request) => JSON.stringify(request.messages).includes("Saved session checklist")));
  assert(initialParent.every((request) => !JSON.stringify(request.messages).includes("EVIDENCE_TOKEN")), "child tool output stays out of parent requests by default");
  assert.equal((await host.call("todos.get", { sessionId })).todos[0].content, "Verify the parser");
  await runtime.dispose(); runtime = undefined;
  await host.stop(); await host.start();
  let saved = (await host.call("session.get", { id: sessionId })).session;
  runtime = runtimeFor(saved.messages, saved.compaction);
  state.phase = "inspect"; state.step = 0;
  const before = requests.length;
  await run("Inspect the recorded evidence from the earlier delegation.");
  assert(JSON.stringify(requests[before].messages).includes("Saved session checklist"), "Host Todo survives restart into the next model request");
  assert(state.trace, JSON.stringify({ errors, toolResults, savedRows: saved.messages?.length }));
  assert.equal(state.trace.entries.length, 1);
  assert(state.trace.entries[0].text.includes("EVIDENCE_TOKEN"));
  assert(requests.slice(before).some((request) => JSON.stringify(request.messages).includes("EVIDENCE_TOKEN")), "only the requested excerpt is returned to the parent");
  await runtime.compactManually();
  await runtime.dispose(); runtime = undefined;
  saved = (await host.call("session.get", { id: sessionId })).session;
  runtime = runtimeFor(saved.messages, saved.compaction);
  state.phase = "continued";
  await run("Continue after compaction.");
  assert(JSON.stringify(requests.at(-1).messages).includes("Saved session checklist"));
  ({ turnId } = await host.call("session.beginTurn", { sessionId }));
  await host.call("tools.execute", { sessionId, turnId, toolCallId: randomUUID(), toolName: "TodoWrite", mode: "agent", args: { todos: [] } });
  await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
  await run("Continue after clearing the checklist.");
  assert(!JSON.stringify(requests.at(-1).messages.filter((message) => message.role === "system")).includes("Saved session checklist"));
  assert(JSON.stringify(requests.at(-1).messages).includes("checklist is empty"));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ ok: true, scenario: "E2E-COLLABORATION-context", restart: true, compaction: true, cleared: true, traceEntries: state.trace.entries.length }));
} finally {
  if (runtime) await runtime.dispose();
  await host.stop();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
