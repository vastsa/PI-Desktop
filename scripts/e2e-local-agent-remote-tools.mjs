#!/usr/bin/env node
/** Isolated local model -> real Main relay -> loopback RACP -> real Rust tools.
 * The Host has no providers. No SSH, credentials, paid APIs or user app is used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "node:module";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { DesktopAgentRuntime } = await import("../packages/agent-runtime/dist/index.js");
const { HostProcess, createHostSessionPort } = await import("../packages/host-runtime/dist/index.js");
const { AgentHost } = await import("../packages/agent-host/dist/index.js");
const { bindRacpWebSocket, RacpServer, MemoryCredentialStore, DeviceTokenAuthenticator, hashToken, newDeviceToken } = await import("../packages/racp/dist/index.js");
const { createWorkspaceTools } = await import("../apps/pi-host/dist/workspace-tools.js");
const { createWorkspaceFiles } = await import("../apps/pi-host/dist/workspace-files.js");
const { createHostOperations } = await import("../apps/pi-host/dist/host-operations.js");
const OWNER_TOKEN = newDeviceToken();
const { createRemoteHostsBoot } = await import("../apps/desktop/electron/main/bootstrap/remote-hosts.ts");
const { createRemoteWorkspaceToolRelay } = await import("../apps/desktop/electron/main/remote/remote-workspace-tools.ts");
const { loadRemoteWorkspaceInstructions } = await import("../apps/desktop/electron/main/remote/remote-workspace-instructions.ts");
const { createBackendRouter } = await import("../apps/desktop/electron/main/remote/backend-router.ts");

assert.ok(process.env.PI_HOST_CORE_BINARY, "PI_HOST_CORE_BINARY must name the current candidate Rust binary");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "local-agent-remote-tools-"));
const remoteRoot = join(root, "remote-workspace");
await mkdir(remoteRoot); await mkdir(join(root, "desktop"));
await writeFile(join(remoteRoot, "README.md"), "REMOTE_READ_FIXTURE\n");
await writeFile(join(remoteRoot, "AGENTS.md"), "REMOTE_REPOSITORY_INSTRUCTIONS_FIXTURE\n");
await writeFile(join(remoteRoot, "CLAUDE.md"), "LOWER_PRIORITY_INSTRUCTIONS_MUST_NOT_LOAD\n");
const KEY = "local-model-fixture-key-never-forwarded";
let modelCalls = 0;
let modelError;
let host;
let localHost;
let relay;
let localPermissions = 0;
let binding;
let boot;
let runtime;
let h;
const wireCalls = [];
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.model, "local-fixture");
    const context = JSON.stringify(input.messages);
    assert.ok(context.includes("REMOTE_REPOSITORY_INSTRUCTIONS_FIXTURE"), "RACP repository instructions enter local model context");
    assert.ok(context.includes("LOCAL_GLOBAL_INSTRUCTIONS_FIXTURE"), "local global defaults remain local model context");
    assert.ok(!context.includes("LOWER_PRIORITY_INSTRUCTIONS_MUST_NOT_LOAD"), "repository precedence is preserved");
    modelCalls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `local-${modelCalls}`, object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (modelCalls <= 2) {
      if (modelCalls === 2) assert.ok(JSON.stringify(input.messages).includes("REMOTE_READ_FIXTURE"), "actual remote Read enters local model context");
      const name = modelCalls === 1 ? "Read" : "Bash";
      const args = name === "Read" ? { path: "README.md" } : { command: "printf 'REMOTE_BASH_FIXTURE\\n' > marker.txt" };
      frame({ role: "assistant", tool_calls: [{ index: 0, id: `local-tool-${modelCalls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      frame({}, "tool_calls");
    } else {
      assert.equal(modelCalls, 3, "model/tool execution is not replayed");
      assert.ok(input.messages.some(message => message.role === "tool"));
      frame({ role: "assistant", content: "LOCAL_MODEL_REMOTE_TOOLS_OK" }); frame({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) { modelError = error; if (!res.headersSent) res.writeHead(500); res.end(); }
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const deadline = setTimeout(() => { console.error("local-Agent remote-tool acceptance exceeded 60s"); process.exit(1); }, 60_000);
try {
  host = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: join(root, "host"), onStderr: () => {} });
  await host.handshake();
  const tools = createWorkspaceTools(() => host);
  let remotePrompts = 0;
  const agentHost = new AgentHost({ sessions: createHostSessionPort(() => host),
    runtime: { async prompt() { remotePrompts++; throw new Error("remote models must not run"); }, async stop() { return { requested: false }; }, async abort() {}, async respondInput() {} },
    approvals: { async resolveTool() { throw new Error("no remote approval"); }, async resolveContract() { throw new Error("no remote contract"); }, async listPendingTools() { return []; } },
  });
  const credentials = new MemoryCredentialStore();
  await credentials.saveDevice({ deviceId: "fixture-owner", label: "Fixture", roles: ["owner"], tokenHash: hashToken(OWNER_TOKEN), createdAt: new Date().toISOString() });
  const authenticator = new DeviceTokenAuthenticator(credentials);
  const operations = createHostOperations({ getHost: () => host, runtime: { isBusy: () => false, async compact() { throw new Error("no remote model"); } } });
  operations.workspaceTools = { ...tools, async execute(input, owner) { wireCalls.push(structuredClone(input)); return tools.execute(input, owner); } };
  operations.workspaceFiles = createWorkspaceFiles();
  h = { server: new RacpServer({ agentHost, operations, authenticator, hostId: "tool-host", serverVersion: "fixture", log: () => {} }), remotePrompts: () => remotePrompts };
  binding = await bindRacpWebSocket({ server: h.server, authenticator, host: "127.0.0.1", port: 0, log: () => {} });
  boot = createRemoteHostsBoot({ dataDir: join(root, "desktop"), router: createBackendRouter(), clientInfo: { name: "local-agent-fixture", version: "fixture" }, emit: () => {}, encryption: { isAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  assert.equal((await boot.addHost({ hostKey: "fixture", label: "Fixture", url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`, deviceToken: OWNER_TOKEN })).connected, true);
  const shell = await boot.workspaceCommandShell("fixture");
  const projectInstructions = await loadRemoteWorkspaceInstructions(boot.workspaceFiles,
    { hostKey: "fixture", path: remoteRoot }, { entries: [{ source: "local-global", content: "LOCAL_GLOBAL_INSTRUCTIONS_FIXTURE" }] });
  localHost = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: join(root, "local-host"), onStderr: () => {} });
  await localHost.handshake();
  const created = await localHost.call("project.group.createRemote", { name: "Locally named remote project", remote: { hostKey: "fixture", path: remoteRoot } });
  const localSession = await localHost.call("session.create", { projectPath: created.group.primaryPath, mode: "agent" });
  relay = createRemoteWorkspaceToolRelay(localHost, { getBoot: () => boot, isCurrent: () => true, isTurnDispatchable: (sessionId, turnId) => sessionId === localSession.session.id && turnId === "local-turn", log: () => {} });
  localHost.onNotification((method, params) => {
    if (method === "tools.remoteExecute") void relay.execute(params);
    if (method === "tools.remoteAbort") relay.cancel(params);
    if (method === "permissions.request") {
      localPermissions++;
      void localHost.call("permissions.resolve", { requestId: params.requestId, decision: "allow-once" });
    }
  });
  let ended;
  const done = new Promise((resolveDone, rejectDone) => { ended = envelope => { if (envelope.event.type === "error") rejectDone(new Error(JSON.stringify(envelope.event))); if (envelope.event.type === "agent_end") resolveDone(); }; });
  runtime = new DesktopAgentRuntime({
    sessionId: localSession.session.id, mode: "agent", thinkingLevel: "off", commandShell: shell,
    projectInstructions,
    remoteWorkspace: { hostKey: "fixture", path: remoteRoot },
    provider: { id: "local-provider", name: "Local fixture", modelId: "local-fixture", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiStyle: "chat_completions", apiKey: KEY, authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    host: { call: (method, params) => localHost.call(method, params), onNotification: handler => localHost.onNotification(handler) },
    onEvent: envelope => ended(envelope),
  });
  await Promise.all([runtime.prompt("Read README.md and write marker.txt using Bash.", "user-1", "local-turn"), done]);
  assert.equal(modelError, undefined);
  assert.equal(modelCalls, 3);
  assert.equal(localPermissions, 1, "Bash is approved by local permissions before remote dispatch");
  assert.equal(await readFile(join(remoteRoot, "marker.txt"), "utf8"), "REMOTE_BASH_FIXTURE\n");
  assert.deepEqual(wireCalls.map(call => call.toolName), ["Read", "Bash"]);
  assert.ok(!JSON.stringify(wireCalls).includes(KEY), "local provider key never crosses the workspace boundary");
  assert.ok(wireCalls.every(call => !Object.keys(call).some(key => /provider|model|secret|auth/i.test(key))));
  const providers = await host.call("providers.list", {});
  assert.equal(providers.providers.length, 0, "Host needs no provider configuration");
  const sessions = await host.call("session.list", {});
  assert.equal(sessions.sessions.length, 0, "tool service creates no persistent remote session");
  const projects = await host.call("projects.list", {});
  assert.equal(projects.projects.length, 0, "tool service creates no persistent remote project");
  assert.equal(h.remotePrompts(), 0, "no remote Agent/model invocation");
  await assert.rejects(boot.executeWorkspaceTool({ ...wireCalls[0], hostKey: "fixture" }), "duplicate tool id cannot replay");
  await boot.removeHost("fixture");
  await assert.rejects(boot.executeWorkspaceTool({ ...wireCalls[0], toolCallId: "after-disconnect", hostKey: "fixture" }), { errorCode: "AGENT_UNAVAILABLE" });
  console.log("PASS local model/key/instructions + local Rust project/permission relay + real RACP/Rust Read/Bash, no remote providers/projects/sessions, no replay/fallback");
} finally {
  clearTimeout(deadline);
  await runtime?.dispose(); relay?.dispose(); await localHost?.dispose(); await boot?.closeAll(); h?.server.close(); await binding?.close(); await host?.dispose();
  model.closeAllConnections(); await new Promise(resolveClose => model.close(resolveClose)); await rm(root, { recursive: true, force: true });
}
