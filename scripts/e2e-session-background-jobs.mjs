// Deterministic local provider -> production agent loop -> real Host/processes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession, configureSession, beginTurn, endTurn } from "./e2e/session.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, ".cache", "session-background-jobs");
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(artifacts, "run-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "failure.cjs"), `
process.stdout.write('中文'.repeat(100000) + '\\nstdout-final\\n');
process.stderr.write('错误'.repeat(100000) + '\\nassertion-failed-final\\n');
process.exitCode = 1;
`);
await writeFile(join(workspace, "service.cjs"), `
console.log('service-ready');
setInterval(() => {}, 1000);
`);
const host = new Host(resolveHostBinary(), join(scratch, "data"), {
  quiet: true,
  env: { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
});
let round = 0;
let failedJob, serviceJob, foreign;
let fixtureFailure;
const calls = [];
const toolResult = (body, id) => {
  const message = body.messages.find(message => message.role === "tool" && message.tool_call_id === id);
  assert(message, `missing tool result ${id}`);
  return message.content;
};
const parseResult = (body, id) => JSON.parse(toolResult(body, id));
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    let name, args;
    switch (round++) {
      case 0:
        name = "Bash"; args = { command: "node failure.cjs", runInBackground: true };
        break;
      case 1:
        failedJob = parseResult(body, "call-1").job;
        assert.equal(failedJob.kind, "bash");
        name = "TaskList"; args = {};
        break;
      case 2:
        assert(toolResult(body, "call-2").includes(failedJob.id));
        name = "TaskWait"; args = { job: failedJob, timeoutSeconds: 20 };
        break;
      case 3: {
        const result = parseResult(body, "call-3");
        assert.equal(result.state, "failed");
        assert.equal(result.exitCode, 1);
        assert.equal(result.truncated, true);
        assert(result.stdout.endsWith("stdout-final\n"));
        assert(result.stderr.endsWith("assertion-failed-final\n"));
        for (const stream of [result.stdout, result.stderr]) {
          assert(Buffer.byteLength(stream) <= 8192);
          assert(!stream.includes("\uFFFD"));
        }
        name = "Bash"; args = { command: "node service.cjs", runInBackground: true };
        break;
      }
      case 4:
        serviceJob = parseResult(body, "call-4").job;
        for (const method of ["wait", "stop"]) {
          await assert.rejects(host.call(`backgroundJobs.${method}`, { sessionId: foreign.id, id: serviceJob.id }), error => error.errorCode === "NOT_FOUND");
          await assert.rejects(host.call(`backgroundJobs.${method}`, { sessionId: foreign.id, id: "missing" }), error => error.errorCode === "NOT_FOUND");
        }
        assert.deepEqual((await host.call("backgroundJobs.list", { sessionId: foreign.id })).tasks, []);
        // A pending wait must leave the Host available for another request.
        let observed = false;
        const pending = host.call("backgroundJobs.wait", { sessionId: owner.id, id: serviceJob.id, timeoutMs: 1000 })
          .then(result => { observed = true; return result; });
        await host.call("backgroundJobs.capabilities", { sessionId: owner.id });
        assert.equal(observed, false, "waiting must release the global Host lock");
        assert.equal((await pending).state, "running");
        name = "TaskWait"; args = { job: serviceJob, timeoutSeconds: 1 };
        break;
      case 5:
        assert.equal(parseResult(body, "call-5").status, "timeout");
        assert.equal(parseResult(body, "call-5").state, "running");
        name = "TaskStop"; args = {};
        break;
      case 6:
        assert.equal((await host.call("backgroundJobs.wait", { sessionId: owner.id, id: serviceJob.id })).state, "running");
        name = "TaskStop"; args = { job: serviceJob };
        break;
      case 7:
        assert.equal(parseResult(body, "call-7").stopRequested, true);
        name = "TaskWait"; args = { job: serviceJob, timeoutSeconds: 20 };
        break;
      case 8:
        assert.equal(parseResult(body, "call-8").state, "stopped");
        break;
      default: throw new Error("Unexpected provider round");
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${round}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`);
    if (name) {
      calls.push(name);
      delta({ role: "assistant", tool_calls: [{ index: 0, id: `call-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      delta({}, "tool_calls");
    } else {
      delta({ role: "assistant", content: "Verified test failure and stopped service." });
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
let runtime, owner, turnId;
const events = [];
try {
  await host.start();
  owner = await createSession(host, workspace, "Job owner");
  foreign = await createSession(host, workspace, "Other session");
  for (const session of [owner, foreign]) await configureSession(host, session, "agent", "auto");
  if (process.platform === "win32") await host.call("settings.set", { defaultCommandShell: "cmd" });
  const { effective: shell } = await host.call("commandShells.list");
  turnId = await beginTurn(host, owner.id);
  runtime = new DesktopAgentRuntime({
    host, sessionId: owner.id, turnId, mode: "agent", projectPath: workspace,
    provider: {
      id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: shell, thinkingLevel: "off", subagents: [],
    onEvent: envelope => events.push(envelope.event),
  });
  await runtime.prompt("Run the background fixtures and inspect their outcomes.", "fixture-user", turnId);
  if (fixtureFailure) throw fixtureFailure;
  assert.equal(round, 9);
  assert.equal(events.some(event => event.type === "error"), false);
  const repeated = await host.call("backgroundJobs.wait", { sessionId: owner.id, id: failedJob.id });
  assert.equal(repeated.exitCode, 1);
  assert(repeated.stderr.endsWith("assertion-failed-final\n"));
  const desktop = await host.call("backgroundTasks.output", { id: failedJob.id });
  assert.equal(desktop.exitCode, repeated.exitCode);
  assert(desktop.stderr.endsWith(repeated.stderr));
  await endTurn(host, turnId);
  turnId = undefined;
  await configureSession(host, owner, "plan", "auto");
  await assert.rejects(host.call("backgroundJobs.wait", { sessionId: owner.id, id: failedJob.id }), error => error.errorCode === "PERMISSION_DENIED");
  console.log(JSON.stringify({ ok: true, calls, rounds: round, shell: shell.id, checks: ["real model tool loop", "no subagents configured", "failure and bounded Unicode output", "cross-session read/stop denied", "wait releases Host lock", "timeout preserves process", "default stop preserves Bash", "explicit stop settles", "repeated reads", "desktop parity", "plan mode denied"] }, null, 2));
} finally {
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "aborted").catch(() => {});
  await host.stop();
  await new Promise(resolve => server.close(resolve));
}
