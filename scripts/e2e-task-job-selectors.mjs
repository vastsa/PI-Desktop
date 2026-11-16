// Issue #2173: real provider transport -> Task -> redundant TaskWait/TaskStop selectors.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession, configureSession, beginTurn, endTurn } from "./e2e/session.mjs";

const artifacts = fileURLToPath(new URL("../.cache/task-job-selectors/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(artifacts, "run-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
const host = new Host(resolveHostBinary(), join(scratch, "data"), { quiet: true });
const delegateStarted = Promise.withResolvers();
let runtime, turnId, fixtureFailure, job;
let round = 0;
const events = [];
const toolResult = (body, id) => {
  const message = body.messages.find(message => message.role === "tool" && message.tool_call_id === id);
  assert(message, `missing tool result ${id}`);
  return message.content;
};
const jobReference = (body, id) => {
  const match = toolResult(body, id).match(/Job reference: (\{.*?\})/);
  assert(match, `missing job reference in ${id}`);
  return JSON.parse(match[1]);
};
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const isDelegate = body.messages.some(message => message.role === "system" &&
      typeof message.content === "string" && message.content.includes("selector-delegate-fixture"));
    let name, args;
    if (isDelegate) {
      if (JSON.stringify(body.messages).includes("selector-stop")) {
        delegateStarted.resolve();
        // Keep the real delegate request pending until TaskStop cancels it.
        await new Promise(resolve => res.once("close", resolve));
        return;
      }
    } else switch (round++) {
      case 0:
        name = "Task"; args = { agent: "selector-fixture", task: "Return a selector report." };
        break;
      case 1:
        job = jobReference(body, "call-1");
        assert.equal(job.kind, "delegation");
        name = "TaskWait"; args = {
          job, delegationIds: [job.id], mode: "all", minCompleted: 1, timeoutSeconds: 180,
        };
        break;
      case 2:
        assert(toolResult(body, "call-2").includes("Selector delegate report."));
        name = "TaskWait"; args = {
          job, delegationIds: [], mode: "any", minCompleted: 2, timeoutSeconds: 600,
        };
        break;
      case 3:
        assert(toolResult(body, "call-3").includes("Selector delegate report."));
        name = "Task"; args = { agent: "selector-fixture", task: "selector-stop: wait for cancellation." };
        break;
      case 4:
        job = jobReference(body, "call-4");
        await delegateStarted.promise;
        name = "TaskStop"; args = { job, delegationIds: [job.id] };
        break;
      case 5:
        assert.match(toolResult(body, "call-5"), /stopped 1 subagent/i);
        name = "TaskWait"; args = {
          job, delegationIds: [], mode: "all", minCompleted: 1, timeoutSeconds: 180,
        };
        break;
      case 6:
        assert(toolResult(body, "call-6").includes("stopped"));
        break;
      default: throw new Error("Unexpected provider round");
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${round}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`);
    if (name) {
      delta({ role: "assistant", tool_calls: [{ index: 0, id: `call-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      delta({}, "tool_calls");
    } else {
      delta({ role: "assistant", content: isDelegate ? "Selector delegate report." : "Verified delegation selectors." });
      delta({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    fixtureFailure = error;
    res.writeHead(400);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const deadline = setTimeout(() => {
  fixtureFailure ??= new Error("Delegation selector fixture exceeded 30 seconds");
  void runtime?.abort();
  server.closeAllConnections();
}, 30_000);
try {
  await host.start();
  const owner = await createSession(host, workspace, "Delegation selector owner");
  await configureSession(host, owner, "agent", "auto");
  const { effective: commandShell } = await host.call("commandShells.list");
  turnId = await beginTurn(host, owner.id);
  runtime = new DesktopAgentRuntime({
    host, sessionId: owner.id, turnId, mode: "agent", projectPath: workspace,
    provider: {
      id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell, thinkingLevel: "off",
    subagents: [{
      name: "selector-fixture", description: "Exercise explicit delegation job controls.",
      prompt: "selector-delegate-fixture", tools: ["Read"], source: "builtin",
    }],
    onEvent: envelope => events.push(envelope.event),
  });
  await runtime.prompt("Start, wait for and stop the selector fixtures.", "selector-user", turnId);
  if (fixtureFailure) throw fixtureFailure;
  assert.equal(round, 7);
  assert.equal(events.some(event => event.type === "error"), false);
  await endTurn(host, turnId);
  turnId = undefined;
  console.log(JSON.stringify({ ok: true, rounds: round, checks: [
    "real Task and delegate provider loop", "matching delegation selectors",
    "empty delegation selectors", "single-job wait options ignored",
    "report re-read", "running delegate stopped", "stopped status re-read",
  ] }, null, 2));
} finally {
  clearTimeout(deadline);
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "aborted");
  await host.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
