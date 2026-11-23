// Deterministic local provider -> production agent loop -> real Host/processes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
await writeFile(join(workspace, "yield.cjs"), `
const { existsSync, appendFileSync } = require("node:fs");
appendFileSync("starts.txt", "start\\n");
console.log("before-yield");
const timer = setInterval(() => {
  if (!existsSync("release.txt")) return;
  clearInterval(timer);
  console.log("after-yield");
  process.exitCode = 7;
}, 50);
`);
await writeFile(join(workspace, "independent.txt"), "work while Bash runs");
await writeFile(join(workspace, "quick.cjs"), "process.exitCode = 4;\n");
await writeFile(join(workspace, "batch.cjs"), `
setTimeout(() => require("node:fs").writeFileSync("batch.txt", "Bash settled"), 11250);
`);
const host = new Host(resolveHostBinary(), join(scratch, "data"), {
  quiet: true,
  env: { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
});
let round = 0;
let failedJob, serviceJob, foreign, failedSnapshot, yieldedJob;
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
    let name, args, laterCall;
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
        failedSnapshot = result;
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
        name = "TaskWait"; args = { job: failedJob, delegationIds: [], mode: "all", minCompleted: 1, timeoutSeconds: 20 };
        break;
      case 9: {
        const result = parseResult(body, "call-9");
        for (const key of ["state", "exitCode", "stdout", "stderr", "truncated"]) {
          assert.deepEqual(result[key], failedSnapshot[key], "redundant wait must preserve " + key);
        }
        name = "Bash"; args = { command: "node service.cjs", runInBackground: true };
        break;
      }
      case 10:
        serviceJob = parseResult(body, "call-10").job;
        assert.equal(serviceJob.kind, "bash");
        name = "TaskWait"; args = { job: serviceJob, delegationIds: [], mode: "any", minCompleted: 1, timeoutSeconds: 1 };
        break;
      case 11:
        assert.equal(parseResult(body, "call-11").status, "timeout");
        assert.equal(parseResult(body, "call-11").state, "running");
        name = "TaskStop"; args = { job: serviceJob, delegationIds: [] };
        break;
      case 12:
        assert.equal(parseResult(body, "call-12").stopRequested, true);
        name = "TaskWait"; args = { job: serviceJob, timeoutSeconds: 20 };
        break;
      case 13:
        assert.equal(parseResult(body, "call-13").state, "stopped");
        name = "Bash"; args = { command: "node quick.cjs" };
        break;
      case 14: {
        const quick = parseResult(body, "call-14");
        assert.equal(quick.exitCode, 4);
        assert.equal(quick.job, undefined);
        name = "Bash"; args = { command: "node yield.cjs", timeout: 25 };
        break;
      }
      case 15: {
        const running = parseResult(body, "call-15");
        assert.equal(running.state, "running");
        assert(running.elapsedMs >= 10_000, "the first wait must use the ten-second window");
        assert.equal(running.exitCode, undefined);
        assert.match(running.stdout, /before-yield/);
        assert.equal(running.job.kind, "bash");
        assert.equal(running.backgroundTaskId, running.job.id);
        yieldedJob = running.job;
        name = "Read"; args = { path: "independent.txt" };
        break;
      }
      case 16:
        assert.match(toolResult(body, "call-16"), /work while Bash runs/);
        assert.equal((await host.call("backgroundJobs.wait", { sessionId: owner.id, id: yieldedJob.id })).state, "running");
        await writeFile(join(workspace, "release.txt"), "");
        name = "TaskWait"; args = { job: yieldedJob, timeoutSeconds: 10 };
        break;
      case 17: {
        const finished = parseResult(body, "call-17");
        assert.equal(finished.state, "failed");
        assert.equal(finished.exitCode, 7);
        assert.equal(finished.stdout.replaceAll("\r", ""), "before-yield\nafter-yield\n");
        assert.equal(await readFile(join(workspace, "starts.txt"), "utf8"), "start\n");
        name = "Bash"; args = { command: "node service.cjs", timeout: 13 };
        break;
      }
      case 18: {
        const running = parseResult(body, "call-18");
        assert.equal(running.state, "running");
        name = "TaskWait"; args = { job: running.job, timeoutSeconds: 15 };
        break;
      }
      case 19: {
        const timedOut = parseResult(body, "call-19");
        assert.equal(timedOut.state, "failed");
        assert.equal(timedOut.exitCode, null);
        assert.match(timedOut.stderr, /timed out after 13000ms/);
        assert(timedOut.elapsedMs < 20000, "the original timeout must include the first wait");
        name = "Bash"; args = { command: "node service.cjs", timeout: 25 };
        break;
      }
      case 20: {
        const running = parseResult(body, "call-20");
        assert.equal(running.state, "running");
        yieldedJob = running.job;
        name = "TaskStop"; args = { job: yieldedJob };
        break;
      }
      case 21:
        assert.equal(parseResult(body, "call-21").stopRequested, true);
        name = "TaskWait"; args = { job: yieldedJob, timeoutSeconds: 10 };
        break;
      case 22:
        assert.equal(parseResult(body, "call-22").state, "stopped");
        name = "Bash"; args = { command: "node batch.cjs", timeout: 20 };
        laterCall = { name: "Read", arguments: JSON.stringify({ path: "batch.txt" }) };
        break;
      case 23:
        assert.equal(parseResult(body, "call-23").exitCode, 0);
        assert.equal(parseResult(body, "call-23").job, undefined);
        assert.match(toolResult(body, "call-23-later"), /Bash settled/);
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
      const toolCalls = [{ index: 0, id: `call-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
      if (laterCall) {
        toolCalls.push({ index: 1, id: `call-${round}-later`, type: "function", function: laterCall });
        calls.push(laterCall.name);
      }
      delta({ role: "assistant", tool_calls: toolCalls });
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
  assert.equal(round, 24);
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
  console.log(JSON.stringify({ ok: true, calls, rounds: round, shell: shell.id, checks: ["real model tool loop", "no subagents configured", "failure and bounded Unicode output", "cross-session read/stop denied", "wait releases Host lock", "timeout preserves process", "default stop preserves Bash", "plain job wait/timeout/stop", "redundant defaults wait/timeout/stop", "explicit stop settles", "repeated reads", "desktop parity", "plan mode denied", "quick Bash remains synchronous", "yielded Bash runs once and allows independent tools", "yielded Bash keeps the original deadline", "explicit stop settles a yielded Bash", "later tool in the same batch waits for Bash"] }, null, 2));
} finally {
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "aborted").catch(() => {});
  await host.stop();
  await new Promise(resolve => server.close(resolve));
}
