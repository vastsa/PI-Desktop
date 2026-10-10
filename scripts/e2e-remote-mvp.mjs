#!/usr/bin/env node
/** Packaged Host + actual Desktop main routing, with only the model/network fixture mocked.
 * This is not SSH/sshd or Electron renderer acceptance. All mutable state is temporary.
 * PI_HOST_E2E_BUNDLE points to the directory produced by pi-host/scripts/bundle.mjs. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("../packages/shared/dist/index.js");
const { createRemoteHostsBoot } = await import("../apps/desktop/electron/main/bootstrap/remote-hosts.ts");
const { createBackendRouter } = await import("../apps/desktop/electron/main/remote/backend-router.ts");
const { exchangePairingToken } = await import("../apps/desktop/electron/main/remote/racp-remote-host-client.ts");

assert.ok(process.env.PI_HOST_E2E_BUNDLE, "PI_HOST_E2E_BUNDLE must name the packaged Host directory");
const bundle = resolve(process.env.PI_HOST_E2E_BUNDLE);
const cli = join(bundle, "pi-host.js");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-mvp-"));
const dataDir = join(root, "host");
const project = join(root, "project");
await mkdir(dataDir, { mode: 0o700 });
await mkdir(join(root, "desktop"), { mode: 0o700 });
await mkdir(project);
await writeFile(join(project, "README.md"), "remote MVP fixture\n");
const dnsFixture = fileURLToPath(new URL("./e2e/remote-mvp-dns.mjs", import.meta.url));
const env = { ...process.env, NODE_OPTIONS: `--import=${dnsFixture}`, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*" };
let calls = 0;
let fixtureFailure;
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.model, "mvp-fixture");
    calls++;
    const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: `mvp-${calls}`, object: "chat.completion.chunk", created: 1, model: input.model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls === 1) {
      assert.ok(input.tools.some((tool) => tool.function?.name === "Bash"), "real runtime exposes Bash");
      frame({ role: "assistant", tool_calls: [{ index: 0, id: "mvp-tool-1", type: "function", function: {
        name: "Bash", arguments: JSON.stringify({ command: "printf 'remote-mvp\\n' >> MVP.txt" }),
      } }] });
      frame({}, "tool_calls");
    } else {
      assert.equal(calls, 2, "no mutation or model request replay");
      assert.ok(input.messages.some((message) => message.role === "tool"), "model receives actual Bash result");
      frame({ role: "assistant", content: "REMOTE_MVP_OK" });
      frame({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) { fixtureFailure = error; if (!res.headersSent) res.writeHead(500); res.end(); }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
let child;
let boot;
let hostLog = "";
const events = new EventEmitter();
const observed = [];
function waitEvent(predicate, timeout = 30_000) {
  const existing = observed.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => { events.off("event", listener); reject(new Error("remote event deadline exceeded")); }, timeout);
    function listener(event) {
      if (!predicate(event)) return;
      clearTimeout(timer); events.off("event", listener); resolveEvent(event);
    }
    events.on("event", listener);
  });
}
async function runImport(payload) {
  const importer = spawn(process.execPath, [cli, "provider-import", "--data-dir", dataDir], { cwd: dataDir, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  importer.stdout.on("data", (chunk) => { output += chunk; });
  importer.stderr.resume();
  importer.stdin.end(JSON.stringify(payload));
  const [code] = await once(importer, "exit");
  assert.equal(code, 0, "CLI imports through the running Host admin socket");
  assert.ok(output.startsWith("PI_HOST_PROVIDERS "));
  return JSON.parse(output.slice("PI_HOST_PROVIDERS ".length));
}
async function stop() {
  await boot?.closeAll();
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
}
try {
  child = spawn(process.execPath, [cli, "--data-dir", dataDir, "--port", "0", "--pair", "--browse-root", root, "--log-level", "warn"], { cwd: dataDir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { hostLog = (hostLog + chunk).slice(-12_000); });
  const ready = await new Promise((resolveReady, reject) => {
    let output = "";
    const found = {};
    const timer = setTimeout(() => reject(new Error("Host readiness deadline exceeded")), 30_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("packaged Host exited before ready")); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (line.startsWith("PI_HOST_READY ")) found.host = JSON.parse(line.slice(14));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) found.pairing = JSON.parse(line.slice(22));
      }
      if (found.host && found.pairing) { clearTimeout(timer); resolveReady(found); }
    });
  });
  const payload = { version: 1, providers: [{ sourceId: "mvp-fixture", input: {
    name: "MVP fixture", vendorKey: "openai", type: "native", protocol: "openai", authKind: "none",
    baseUrl: `http://remote-mvp.test:${model.address().port}/v1`, apiStyle: "chat_completions", defaultModelId: "mvp-fixture",
    models: [{ id: "mvp-fixture", contextWindow: 32768, maxTokens: 2048, thinkingLevels: [], defaultThinkingLevel: null }],
    supportsReasoning: false, supportedThinkingLevels: [],
  } }], defaultModel: { sourceId: "mvp-fixture", modelId: "mvp-fixture" } };
  const imported = await runImport(payload);
  assert.equal(imported.imported.length, 1);
  assert.equal(imported.defaultSet, true);
  assert.deepEqual(await runImport(payload), imported, "repeat import is idempotent");
  const url = `ws://127.0.0.1:${ready.host.port}/v1/racp/ws`;
  const clientInfo = { name: "remote-mvp-fixture", version: "0.18.0" };
  const deviceToken = await exchangePairingToken({ url, pairingToken: ready.pairing.token, label: "MVP test", clientInfo });
  const router = createBackendRouter();
  boot = createRemoteHostsBoot({ dataDir: join(root, "desktop"), router, clientInfo,
    encryption: { isAvailable: () => true, encryptString: (plain) => Buffer.from(plain), decryptString: (value) => value.toString() },
    emit: (channel, payload) => { const event = { channel, payload }; observed.push(event); events.emit("event", event); },
  });
  assert.equal((await boot.addHost({ hostKey: "fixture", label: "Packaged Host", url, deviceToken })).connected, true);
  const registered = await boot.registerProject("fixture", project);
  const session = await boot.createSession({ hostKey: "fixture", projectId: registered.id, permissionMode: "ask" });
  assert.equal(session.projectPath, undefined, "remote path never becomes local workspace");
  const route = async (channel, input) => (await router.route(channel, [input])).value;
  await route(IPC.invoke.sessionGet, { id: session.id });
  const approval = waitEvent((event) => event.payload?.event?.type === "tool_permission_request");
  await route(IPC.invoke.agentPrompt, { sessionId: session.id, content: "Create the MVP marker file." });
  const permission = (await approval).payload.event.request;
  await boot.reconnectHost("fixture");
  const ended = waitEvent((event) => event.payload?.event?.type === "agent_end");
  await route(IPC.invoke.toolResolvePermission, { requestId: permission.requestId, decision: "allow-once" });
  await ended;
  assert.equal(fixtureFailure, undefined);
  assert.equal(calls, 2);
  const content = await route(IPC.invoke.fsRead, { sessionId: session.id, path: "MVP.txt" });
  assert.equal(content.content, "remote-mvp\n", "Bash executes once on Host after reconnect");
  const transcript = await route(IPC.invoke.sessionGet, { id: session.id });
  assert.ok(JSON.stringify(transcript.session.messages).includes("REMOTE_MVP_OK"));
  await assert.rejects(route(IPC.invoke.fsRead, { sessionId: session.id, path: "../outside" }));
  await route(IPC.invoke.workspaceDiff, { sessionId: session.id });
  await boot.removeHost("fixture");
  await assert.rejects(route(IPC.invoke.agentPrompt, { sessionId: session.id, content: "must not run locally" }), { errorCode: "AGENT_UNAVAILABLE" });
  console.log("PASS packaged Host: import/reimport, pair, project, session, prompt, approval across reconnect, file read, diff, removal");
} catch (error) {
  console.error(error);
  console.error(hostLog);
  if (fixtureFailure) console.error(fixtureFailure);
  process.exitCode = 1;
} finally { await stop(); await rm(root, { recursive: true, force: true }); }
