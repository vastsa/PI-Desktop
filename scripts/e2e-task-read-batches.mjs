// Local provider -> production Runtime/pi -> real delegate loop -> real Host.
// Proves a mixed Task/read batch stays sequential, holds the subsequent parent
// read until a same-batch writable delegate settles, and keeps Task's ADR 0089
// contract: it reports a started delegation, never the settled report.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession, configureSession, beginTurn, endTurn } from "./e2e/session.mjs";

const DELEGATE_MARKER = "delegate-marker";
const WRITTEN_MARKER = "written-by-delegate-marker";
const scratch = await mkdtemp(join(tmpdir(), "pi-task-read-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "target.txt"), "original-marker\n");

const requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const isDelegate = JSON.stringify(body.messages[0] ?? {}).includes(DELEGATE_MARKER);
    const hasToolResult = body.messages.some(message => message.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`);
    const emitCalls = calls => {
      delta({ role: "assistant", tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) });
      delta({}, "tool_calls");
    };
    if (isDelegate && !hasToolResult) {
      emitCalls([{ id: "write", name: "Write", arguments: { path: "target.txt", content: `${WRITTEN_MARKER}\n` } }]);
    } else if (isDelegate) {
      delta({ role: "assistant", content: "delegate-done" });
      delta({}, "stop");
    } else if (!hasToolResult) {
      emitCalls([
        { id: "task", name: "Task", arguments: { agent: "editor", task: "Rewrite target.txt." } },
        { id: "read", name: "Read", arguments: { path: "target.txt" } },
      ]);
    } else {
      delta({ role: "assistant", content: "parent-done" });
      delta({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const host = new Host(resolveHostBinary(), join(scratch, "data"));
let runtime, turnId;
const events = [];
// One timeline for both sides: Host dispatches and the Task tool result.
const dispatch = [];
const toolResults = new Map();
try {
  await host.start(PROTOCOL_VERSION);
  const session = await createSession(host, workspace, "Task and read");
  await configureSession(host, session, "agent", "auto");
  turnId = await beginTurn(host, session.id);
  const call = host.call.bind(host);
  host.call = async (method, args, timeout) => {
    if (method !== "tools.execute") return call(method, args, timeout);
    dispatch.push(`${args.toolCallId}:start`);
    const result = await call(method, args, timeout);
    dispatch.push(`${args.toolCallId}:end`);
    toolResults.set(args.toolCallId, result);
    return result;
  };
  runtime = new DesktopAgentRuntime({
    host, sessionId: session.id, turnId, mode: "agent", projectPath: workspace,
    scratchDir: join(scratch, "scratch"),
    provider: {
      id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{
      name: "editor",
      description: "Edit files.",
      tools: ["Read", "Write"],
      prompt: `${DELEGATE_MARKER}: rewrite the fixture file.`,
      source: "builtin",
    }],
    thinkingLevel: "off",
    onEvent: envelope => {
      if (envelope.event.type === "tool_end" && envelope.event.toolCallId === "task") {
        dispatch.push("task:end");
      }
      events.push(envelope.event);
    },
  });
  await runtime.prompt("Delegate the rewrite, then read the file.", "fixture-user", turnId);
  const taskEnd = events.find(
    event => event.type === "tool_end" && event.toolCallId === "task",
  );
  assert.ok(taskEnd, "the Task call never reported a tool result");
  // Task returns its started notice first, then the writable delegate finishes
  // its Write before the parent's same-batch Read is dispatched to Host.
  assert.deepEqual(dispatch, ["task:end", "write:start", "write:end", "read:start", "read:end"]);
  // ADR 0089 still holds: Task reported a started delegation, not a report.
  const taskText = JSON.stringify(taskEnd.result);
  assert.match(taskText, /working in the background/);
  assert.match(taskText, /"status":"running"/);
  assert.doesNotMatch(taskText, /delegate-done/);
  // The parent read sees the delegate's mutation instead of racing it.
  const readText = JSON.stringify(toolResults.get("read"));
  assert.match(readText, new RegExp(WRITTEN_MARKER));
  assert.doesNotMatch(readText, /original-marker/);
  // The parent batch, the delegate's tool turn, the delegate's answer and the
  // parent's follow-up. Later parent turns may add requests, never fewer.
  assert.ok(requests.length >= 4, `expected at least 4 model requests, saw ${requests.length}`);
  assert.equal(events.some(event => event.type === "error"), false);
  await endTurn(host, turnId);
  turnId = undefined;
  console.log("PASS task-read E2E: mixed Task/read batch stays sequential, Task stays non-blocking");
} finally {
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "error");
  await host.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
