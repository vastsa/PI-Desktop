// Deterministic provider, production runtime + Main admission/coordinator, real Host/process.
// No provider credentials, production profile or user follow-up message.
import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createBackgroundContinuationCoordinator } = await import("../apps/desktop/electron/main/runtime/background-continuations.ts");
const { createAgentHostBridge } = await import("../apps/desktop/electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../apps/desktop/electron/main/ipc/agent-ipc.ts");
const { IPC } = await import("../packages/shared/dist/index.js");
const { DesktopAgentRuntime } = await import("../packages/agent-runtime/dist/runtime.js");
const { Host, resolveHostBinary } = await import("./e2e/host.mjs");
const { createSession, configureSession, beginTurn, endTurn } = await import("./e2e/session.mjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, ".cache", "background-continuation");
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(artifacts, "run-")), workspace = join(scratch, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "test.cjs"), `const fs=require('fs');const timer=setInterval(()=>{if(!fs.existsSync('release'))return;clearInterval(timer);process.stdout.write('final-stdout\\n');process.stderr.write('final-assertion-error\\n');process.exitCode=7;},50);`);
const host = new Host(resolveHostBinary(), join(scratch, "data"), { quiet: true, env: { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) } });
let round = 0, job, fixtureFailure, resumed = false, settled = false, runtime, bridge, coordinator, wakeTimer;
const starts = [], errors = [], messages = [], handlers = new Map(), activeTurns = new Map();
const provider = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const step = round++;
    let delta;
    if (step === 0) {
      assert(body.tools.some(tool => tool.function.name === "Bash" && tool.function.parameters.properties.notifyOnExit));
      delta = { role: "assistant", tool_calls: [{ index: 0, id: "launch-test", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "node test.cjs", runInBackground: true, notifyOnExit: true }) } }] };
    } else if (step === 1) {
      const result = JSON.parse(body.messages.find(message => message.role === "tool" && message.tool_call_id === "launch-test").content);
      job = result.job; assert.equal(result.continuationRequested, true);
      delta = { role: "assistant", content: "Tests are running; I will handle the result when they finish." };
    } else if (step === 2) {
      assert.equal(settled, true, "first turn must really end before resume");
      const result = body.messages.find(message => message.role === "tool" && message.tool_call_id === `background-completion-${job.id}`);
      assert(result, "the same job result must enter context as tool data");
      assert.match(result.content, /final-assertion-error/); assert.match(result.content, /"exitCode":7/);
      assert.equal(body.messages.filter(message => message.role === "user").length, 1, "no invented user request");
      resumed = true;
      delta = { role: "assistant", content: "The original test failed with exit code 7; its final assertion output is available." };
    } else throw new Error("duplicate automatic turn");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (value, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${step}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
    chunk(delta); chunk({}, step === 0 ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
  } catch (error) { fixtureFailure = error; res.writeHead(400); res.end(String(error)); }
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
let continuationRun;
try {
  await host.start();
  assert.notEqual((await host.call("settings.get")).backgroundJobContinuationEnabled, true, "legacy/missing setting is off");
  await host.call("settings.set", { backgroundJobContinuationEnabled: true, ...(process.platform === "win32" ? { defaultCommandShell: "cmd" } : {}) });
  const owner = await createSession(host, workspace, "Automatic continuation fixture");
  await configureSession(host, owner, "agent", "auto");
  const { effective: commandShell } = await host.call("commandShells.list");
  const providerConfig = { id: "fixture", name: "Local deterministic fixture", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"] };
  const sidecar = { setProjectInstructionRoot() {}, async call(method, params) {
    assert.equal(method, "agent.prompt"); starts.push(params.turnId);
    continuationRun = runtime.prompt({ text: params.content, backgroundCompletion: params.backgroundCompletion }, undefined, params.turnId).then(async () => {
      await endTurn(host, params.turnId); activeTurns.delete(owner.id);
    });
    return { accepted: true, turnId: params.turnId };
  } };
  bridge = createAgentHostBridge({ getHost: () => host, channels: IPC.invoke, invoke: (channel, args) => handlers.get(channel)(...args), isSessionBusy: id => activeTurns.has(id), log: (...args) => errors.push(args) });
  coordinator = createBackgroundContinuationCoordinator({ getHost: () => host, start: (sessionId, origin) => bridge.startBackgroundContinuation(sessionId, origin), isQuitting: () => false, log: (...args) => errors.push(args) });
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => bridge,
    modeRuns: { definitionForPrompt: async () => undefined, prepareTurn: async () => undefined },
    logger: { app() {} }, persistenceOutbox: {}, dataDir: join(scratch, "data"), activeTurns, activeTurnUsages: new Map(), completionNoticeTurns: new Set(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart() {}, isTurnDispatchable: (id, turn) => activeTurns.get(id) === turn, acquireSessionOperation: async () => () => {},
    resolveAgentRuntimeLaunch: async () => ({ workspaceRoot: workspace, providerId: "fixture", modelId: "fixture", sidecarParams: { sessionId: owner.id, mode: "agent", provider: providerConfig } }),
    finishTurn: async (id, reason, code, options) => { await endTurn(host, options.turnId, reason); activeTurns.delete(id); },
    emitAgentEvent: envelope => { messages.push(envelope.event); bridge.ingest(envelope); }, setNotificationViewingSessionId() {},
  });
  const first = await beginTurn(host, owner.id); activeTurns.set(owner.id, first);
  runtime = new DesktopAgentRuntime({ host, sessionId: owner.id, turnId: first, mode: "agent", projectPath: workspace, commandShell, provider: providerConfig, backgroundJobContinuationEnabled: true, thinkingLevel: "off", subagents: [], onEvent: envelope => { coordinator.observe(envelope); if (envelope.event.type === "error") errors.push(envelope.event); } });
  await runtime.prompt("Run the test in the background and arrange to continue after it completes.", "initial-user", first);
  if (fixtureFailure) throw fixtureFailure;
  assert.equal((await host.call("backgroundJobs.wait", { sessionId: owner.id, id: job.id })).state, "running");
  await endTurn(host, first); activeTurns.delete(owner.id); settled = true;
  await writeFile(join(workspace, "release"), "ready");
  // Same event-driven wake as wireHost; the harness exposes notifications as a log.
  let cursor = 0;
  wakeTimer = setInterval(() => {
    const next = host.notifications.slice(cursor); cursor = host.notifications.length;
    if (next.some(event => event.method === "backgroundTasks.changed")) coordinator.wake();
  }, 25);
  const deadline = Date.now() + 20_000;
  while (!resumed && !fixtureFailure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (fixtureFailure) throw fixtureFailure;
  assert.equal(resumed, true, JSON.stringify(errors)); await continuationRun;
  coordinator.wake(); await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(starts.length, 1); assert.equal(round, 3); assert.deepEqual(errors, []);
  const detail = await host.call("session.get", { id: owner.id });
  assert.equal(detail.session.messages.filter(message => message.role === "user").length, 0, "Main adds no synthetic user row");
  assert(detail.session.messages.some(message => message.role === "tool" && message.toolCallId === `background-completion-${job.id}`));
  // Actual settings writes revoke pending intent without touching its process.
  await writeFile(join(workspace, "waiting.cjs"), "setInterval(() => {}, 1000)");
  const source = await beginTurn(host, owner.id);
  const execute = (call, command) => host.call("tools.execute", {
    sessionId: owner.id, turnId: source, toolCallId: call, toolName: "Bash", mode: "agent", runInBackground: true,
    expectedCommandShellId: commandShell.id, expectedCommandShellDialect: commandShell.dialect,
    args: { command, runInBackground: true, notifyOnExit: true },
  });
  const launched = await execute("cancel-on-disable", "node waiting.cjs");
  assert.equal(launched.ok, true);
  const pendingJob = launched.content.job;
  await host.call("settings.set", { backgroundJobContinuationEnabled: false });
  const tasks = (await host.call("backgroundTasks.list")).tasks;
  assert.equal(tasks.find(task => task.id === pendingJob.id).continuation, "cancelled");
  assert.equal((await host.call("backgroundJobs.wait", { sessionId: owner.id, id: pendingJob.id })).state, "running");
  await assert.rejects(execute("disabled-registration", "node test.cjs"), error => error.errorCode === "PERMISSION_DENIED");
  assert.equal((await host.call("backgroundTasks.list")).tasks.length, tasks.length);
  await host.call("backgroundJobs.stop", { sessionId: owner.id, id: pendingJob.id, timeoutMs: 1000 });
  await endTurn(host, source);
  assert.deepEqual((await host.call("backgroundContinuations.list", {})).tasks, []);
  console.log(JSON.stringify({ ok: true, rounds: round, continuationTurns: starts.length, checks: ["original turn ended before process exit", "no follow-up user message", "same job and final error output", "Main identity + AgentHost admission", "tool result rather than user instruction", "single continuation", "default off", "disable revokes without killing process", "disabled launch rejected before registration"] }, null, 2));
} finally {
  clearInterval(wakeTimer); coordinator?.dispose(); await runtime?.dispose(); await host.stop(); await new Promise(resolve => provider.close(resolve));
}
