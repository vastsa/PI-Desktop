// Real Desktop IPC/sidecar cancellation with a local streaming provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const show = process.argv.includes("--show");
const scratch = await mkdtemp(join(tmpdir(), "pi-subagent-stop-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "home"));
const workers = new Map();
const parents = new Set();
let sequence = 0;
const requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const users = body.messages.filter(message => message.role === "user");
    const input = JSON.stringify(users.at(-1)?.content);
    const label = input.includes("Fixture worker A") ? "A" : input.includes("Fixture worker B") ? "B" : null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${++sequence}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    if (input.includes("Continue immediately after Stop")) {
      delta({ role: "assistant", content: "Follow-up completed after Stop." });
      delta({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (label) {
      workers.set(label, res);
      res.on("close", () => { if (workers.get(label) === res) workers.delete(label); });
      delta({ role: "assistant", content: `Partial output from worker ${label}. Waiting for cancellation.` });
      return;
    }
    const tools = body.messages.filter(message => message.role === "tool");
    if (tools.some(message => message.tool_call_id?.startsWith("task_"))) {
      parents.add(res);
      res.on("close", () => parents.delete(res));
      res.write(": coordinator still working\n\n");
      return;
    }
    const calls = body.tools?.some(tool => tool.function?.name === "Task")
      ? ["A", "B"].map(label => ({ id: `task_${label}`, name: "Task", arguments: { agent: "explorer", task: `Fixture worker ${label}`, description: `Worker ${label}` } }))
      : [{ id: "discover", name: "ToolSearch", arguments: { query: "Task" } }];
    delta({ role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    delta({}, "tool_calls");
    res.end("data: [DONE]\n\n");
  } catch (error) { res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(check, message = "condition") {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}\n${output.slice(-2500)}`);
}
async function terminateChildTree(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = new Promise(resolve => processHandle.once("exit", resolve));
  const signalTree = signal => {
    try {
      if (process.platform === "win32") processHandle.kill(signal);
      else process.kill(-processHandle.pid, signal);
    } catch {
      processHandle.kill(signal);
    }
  };
  signalTree("SIGTERM");
  const timeout = setTimeout(() => {
    if (processHandle.exitCode === null) signalTree("SIGKILL");
  }, 5_000);
  await exited;
  clearTimeout(timeout);
}
async function connect(port, type) {
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === type && (type !== "page" || target.url.includes("/out/renderer/index.html") && !target.url.includes("surface="))); }
    catch { return null; }
  }, `CDP ${type}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(String(data));
    if (packet.id && pending.has(packet.id)) {
      const { resolve, reject, timer } = pending.get(packet.id);
      clearTimeout(timer);
      pending.delete(packet.id);
      packet.error ? reject(new Error(JSON.stringify(packet.error))) : resolve(packet.result);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, call, evaluate: async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  } };
}
const ports = [await freePort(), await freePort()];
const env = { ...process.env, HOME: join(scratch, "home"), PI_DESKTOP_DATA_DIR: join(scratch, "data"), PI_DESKTOP_HOST_BIN: resolveHostBinary(), PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, PI_DESKTOP_TEST_MODEL: "deepseek-flash", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolveElectronBinary(root).electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${join(scratch, "profile")}`, "."], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
let output = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { output += chunk; });
let main, page;
try {
  main = await connect(ports[1], "node");
  page = await connect(ports[0], "page");
  await page.call("Runtime.enable", {});
  page.ws.addEventListener("message", ({data}) => {
    const event = JSON.parse(String(data));
    if (event.method === "Runtime.exceptionThrown") console.error(JSON.stringify(event.params));
  });
  await until(() => page.evaluate("!!window.piDesktop"), "preload startup");
  await until(() => page.evaluate("!!window.__PI_DESKTOP__"), "renderer startup");
  await until(() => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"), "main probe startup");
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${JSON.stringify(workspace)}})`);
  assert.equal(setup.ok, true, JSON.stringify(setup));
  const invoke = (key, ...input) => page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${JSON.stringify(key)}],...${JSON.stringify(input)})`);
  assert.equal((await invoke("providersUpdate", { id: setup.providerId, models: [{ id: setup.modelId, contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off", "medium"], defaultThinkingLevel: "medium" }] })).ok, true);
  assert.equal((await invoke("sessionConfigure", setup.sessionId, { mode: "agent", providerId: setup.providerId, modelId: setup.modelId, thinkingLevel: "medium" })).ok, true);
  await invoke("sessionRename", setup.sessionId, "Subagent stop controls · local fixture");
  await page.evaluate(`window.__PI_DESKTOP__.refreshProviders().then(() => window.__PI_DESKTOP__.selectSession(${JSON.stringify(setup.sessionId)}))`);
  assert.equal((await invoke("agentPrompt", { sessionId: setup.sessionId, content: "Start two fixture workers for the stop controls demo." })).ok, true);
  await until(() => workers.size === 2 && parents.size > 0, "two real delegates and coordinator");
  const buttons = () => page.evaluate(`Array.from(document.querySelectorAll('.subagent-topology-node-actions .subagent-stop-button')).map(b=>({text:b.textContent,disabled:b.disabled}))`);
  await until(async () => (await buttons()).length === 2, "two stop buttons");
  await page.evaluate(`document.querySelector('.subagent-topology-node-header').click()`);
  await until(() => page.evaluate(`!!document.querySelector('.subagent-transcript-composer-controls .stop-btn')`), "detail stop control");
  await until(() => page.evaluate(`document.body.innerText.includes('Partial output from worker A')`), "worker A partial output rendered");
  const layout = await page.evaluate(`({
    models: [...document.querySelectorAll('.subagent-topology-node-model')].map(e => ({
      text: e.textContent,
      clipped: e.scrollWidth > e.clientWidth + 1,
      ellipsis: getComputedStyle(e).textOverflow === 'ellipsis'
    })),
    stops: [...document.querySelectorAll('.subagent-topology-node-actions .subagent-stop-button')].map(e => ({
      text: e.innerText.trim(), opacity: getComputedStyle(e).opacity,
      rightGap: e.parentElement.getBoundingClientRect().right - e.getBoundingClientRect().right,
      bottomGap: e.parentElement.getBoundingClientRect().bottom - e.getBoundingClientRect().bottom
    }))
  })`);
  assert.ok(layout.models.length === 2 && layout.models.every(m => m.text === "deepseek-flash medium" && !m.clipped && !m.ellipsis), `model and thinking labels remain readable with the detail panel open: ${JSON.stringify(layout.models)}`);
  assert.ok(layout.stops.length === 2 && layout.stops.every(b => b.text && b.opacity === "1" && Math.abs(b.rightGap - 10) < 1 && Math.abs(b.bottomGap - 10) < 1), "stop actions have visible text without hovering");
  const before = requests.length;
  await page.evaluate(`document.querySelector('.subagent-transcript-composer-controls .stop-btn').click()`);
  await until(() => !workers.has("A") && workers.has("B"), "only worker A cancelled");
  await until(async () => (await buttons()).length === 1, "terminal card removes stop");
  assert.equal(parents.size, 1, "coordinator stays running");
  assert.equal(requests.length, before, "stop sends no model request");
  await until(() => page.evaluate(`document.body.innerText.includes('Partial output from worker A')`), "partial delegate output survives");
  await page.evaluate(`document.querySelector('.subagent-activity-header > .subagent-stop-button').click()`);
  await until(() => workers.size === 0, "stop-all cancels remaining delegates");
  assert.equal(parents.size, 1, "stop-all preserves coordinator");
  await until(async () => (await buttons()).length === 0, "all terminal controls disappear");
  const invalid = await invoke("agentStopSubagents", { sessionId: setup.sessionId, delegationIds: [] });
  assert.equal(invalid.ok, false, "empty selection must not mean stop-all");
  await until(async () => {
    const session = await invoke("sessionGet", { id: setup.sessionId });
    const taskRows = session.data.session.messages.filter(message => message.toolName === "Task");
    return taskRows.length === 2 && taskRows.every(message => message.toolResult?.details?.status === "stopped");
  }, "terminal statuses persisted");
  console.log("PASS Desktop card/detail stop, session stop-all, parent isolation, partial output, persistence and invalid selection");
  await invoke("agentAbort", { sessionId: setup.sessionId });
  const followUp = await invoke("agentPrompt", {
    sessionId: setup.sessionId,
    content: "Continue immediately after Stop.",
  });
  assert.equal(followUp.ok, true, "a follow-up prompt is accepted as soon as Stop returns");
  await until(
    () => requests.some(request => JSON.stringify(request.messages).includes("Continue immediately after Stop")),
    "follow-up reaches the local provider without AGENT_BUSY",
  );
  let followUpState;
  await until(async () => {
    const session = await invoke("sessionGet", { id: setup.sessionId });
    const status = await invoke("agentGetStatus", setup.sessionId);
    const responsePersisted = session.data.session.messages.some(
      message => message.role === "assistant" && String(message.content ?? "").includes("Follow-up completed after Stop."),
    );
    followUpState = { status: status.data.status, responsePersisted };
    return status.data.status?.isRunning === false && responsePersisted;
  }, "follow-up turn completes and persists").catch(error => {
    throw new Error(`${error.message}\nLast follow-up state: ${JSON.stringify(followUpState)}`);
  });
  console.log("PASS same-session follow-up starts immediately after Stop returns");
  if (show) {
    const demo = await invoke("sessionCreate", { title: "子智能体停止演示 · 本地模拟模型", mode: "agent", providerId: setup.providerId, modelId: setup.modelId, projectPath: workspace });
    const demoId = demo.data.session.id;
    assert.equal((await invoke("sessionConfigure", demoId, { mode: "agent", providerId: setup.providerId, modelId: setup.modelId, thinkingLevel: "medium" })).ok, true);
    await page.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(demoId)})`);
    await invoke("agentPrompt", { sessionId: demoId, content: "这是本地模拟模型演示：启动两个子智能体，可以分别停止，或停止全部。主智能体继续运行。" });
    await until(() => workers.size === 2 && parents.size > 0, "demo ready");
    await page.evaluate(`document.querySelector('.subagent-topology-node-header').click()`);
    await until(() => page.evaluate(`!!document.querySelector('.subagent-transcript-composer-controls .stop-btn')`), "demo detail stop control");
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(scratch, "demo.png"), Buffer.from(shot.data, "base64"));
    console.log(`DEMO ${JSON.stringify({ scratch, ports, pid: child.pid })}`);
    main.ws.close();
    await new Promise(resolve => child.once("exit", resolve));
  }
} finally {
  main?.ws.close(); page?.ws.close();
  await terminateChildTree(child);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (!show) await rm(scratch, { recursive: true, force: true });
}
