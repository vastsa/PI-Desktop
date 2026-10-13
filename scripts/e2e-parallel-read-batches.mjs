// Local provider -> production Runtime/pi -> real Host -> temporary files.
// A response barrier proves concurrent dispatch, not filesystem-body overlap.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { SubagentRun } from "../packages/agent-runtime/dist/subagent.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession, configureSession, beginTurn, endTurn } from "./e2e/session.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pi-parallel-read-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "a.txt"), "alpha-marker\n");
await writeFile(join(workspace, "b.txt"), "beta-marker\n");
const calls = [
  { id: "read-a", name: "Read", arguments: { path: "a.txt" } },
  { id: "read-b", name: "Read", arguments: { path: "b.txt" } },
  { id: "glob", name: "Glob", arguments: { pattern: "*.txt" } },
  { id: "grep", name: "Grep", arguments: { pattern: "alpha-marker", path: "." } },
];
const requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`);
    if (!body.messages.some(message => message.role === "tool")) {
      delta({ role: "assistant", tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) });
      delta({}, "tool_calls");
    } else {
      delta({ role: "assistant", content: "parallel-read-complete" });
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
const returnedReads = [];
let releaseReads;
let barrier = new Promise(resolve => { releaseReads = resolve; });
let barrierTimeout = setTimeout(releaseReads, 10_000);
try {
  await host.start(PROTOCOL_VERSION);
  const session = await createSession(host, workspace, "Parallel reads");
  await configureSession(host, session, "agent", "auto");
  turnId = await beginTurn(host, session.id);
  const call = host.call.bind(host);
  host.call = async (method, args, timeout) => {
    const result = await call(method, args, timeout);
    if (method === "tools.execute" && ["read-a", "read-b"].includes(args.toolCallId)) {
      returnedReads.push(args.toolCallId);
      if (returnedReads.length === 2) releaseReads();
      await barrier;
      assert.equal(returnedReads.length, 2, "second Read never dispatched before the first response was released");
    }
    return result;
  };
  runtime = new DesktopAgentRuntime({
    host, sessionId: session.id, turnId, mode: "agent", projectPath: workspace,
    provider: {
      id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    thinkingLevel: "off", onEvent: envelope => events.push(envelope.event),
  });
  await runtime.prompt("Read and search the fixture files.", "fixture-user", turnId);
  assert.equal(requests.length, 2);
  assert.deepEqual(returnedReads.slice().sort(), ["read-a", "read-b"]);
  const results = requests[1].messages.filter(message => message.role === "tool");
  assert.deepEqual(results.map(message => message.tool_call_id), calls.map(call => call.id));
  assert.match(JSON.stringify(results[0].content), /alpha-marker/);
  assert.match(JSON.stringify(results[1].content), /beta-marker/);
  assert.match(JSON.stringify(results[2].content), /a\.txt/);
  assert.match(JSON.stringify(results[3].content), /alpha-marker/);
  assert.equal(events.some(event => event.type === "error"), false);
  // Exercise the real delegate loop with the parent's scoped Host tool bridge.
  returnedReads.length = 0;
  clearTimeout(barrierTimeout);
  barrier = new Promise(resolve => { releaseReads = resolve; });
  barrierTimeout = setTimeout(releaseReads, 10_000);
  const definition = { name: "reader", description: "Read", tools: ["Read", "Glob", "Grep"], prompt: "Read", source: "builtin" };
  const names = new Set(definition.tools);
  const tools = [...runtime.toolCatalog.values()].filter(tool => names.has(tool.name));
  let child;
  const apply = instructions => child.setSystemPrompt(`Child rules: ${JSON.stringify(instructions)}`);
  const parentPrompt = runtime.agent.state.systemPrompt;
  child = new SubagentRun({
    definition, sessionId: session.id, turnId, parentToolCallId: "fixture-task",
    task: "Read and search the fixture files.", provider: runtime.provider,
    thinkingLevel: "off", systemPrompt: "Read the fixture files.",
    tools: runtime.scopeDelegateTools(tools, definition, "fixture-delegate", apply),
    beforeToolCall: context => runtime.preparePathToolCall(context, apply, names),
    onEvent: envelope => events.push(envelope.event),
  });
  const report = await child.run();
  assert.equal(report.status, "completed");
  assert.deepEqual(returnedReads.slice().sort(), ["read-a", "read-b"]);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].messages.filter(message => message.role === "tool").map(message => message.tool_call_id), calls.map(call => call.id));
  assert.equal(runtime.agent.state.systemPrompt, parentPrompt);
  await endTurn(host, turnId);
  turnId = undefined;
  console.log("PASS parallel-read E2E: local HTTP provider, parent/delegate concurrent Read dispatch, real Read/Glob/Grep, source-order results, parent prompt isolation");
} finally {
  releaseReads();
  clearTimeout(barrierTimeout);
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "error");
  await host.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
