import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginProviderInferenceBroker } = await import("../electron/main/plugin-provider-inference.ts");
const { createImageGenerationTool } = await import("../electron/main/services/image-generation-service.ts");
const { DesktopAgentRuntime } = await import("../../../packages/agent-runtime/dist/runtime.js");
const { SubagentRun } = await import("../../../packages/agent-runtime/dist/subagent.js");
const { buildProviderModel, createProviderModels } = await import("../../../packages/agent-runtime/dist/provider-binding.js");
const { withPluginProviderInference } = await import("../../../packages/agent-runtime/dist/plugin-provider-inference.js");
const { genericModelConfig } = await import("../../../packages/agent-runtime/dist/model-capabilities.js");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
const row = { id: "plugin:fixture.inference:gateway", ownerPluginId: "fixture.inference", name: "Gateway", enabled: true,
  authKind: "api_key", models: ["chat", "delegate", "image", "malformed", "blocked"].map(id => ({ id, thinkingLevels: ["off"], defaultThinkingLevel: "off", availableForSubagents: true })) };
const fixture = `module.exports = { providerAdapters: { gateway: { version: 1,
  chat: async function* (request, context) {
    if (context.credential.apiKey !== 'only-own-key') throw new Error('wrong scoped credential');
    if (request.modelId === 'malformed') { yield {type:'toolCall',id:'bad',name:'Read',arguments:'not-an-object'}; return; }
    if (request.modelId === 'blocked') {
      yield {type:'text',delta:'ready'};
      await new Promise(resolve => context.signal.addEventListener('abort',resolve,{once:true}));
      yield {type:'text',delta:'late'}; return;
    }
    if (request.modelId === 'chat' && !request.messages.some(message => message.role === 'toolResult')) {
      yield {type:'thinking',delta:'consider',signature:'vendor-signed-thinking'};
      yield {type:'text',delta:'Reading'};
      yield {type:'toolCall',id:'read-1',name:'Read',arguments:{path:'fixture.txt'},thoughtSignature:'vendor-tool-signature'};
      yield {type:'done',stopReason:'toolUse',usage:{input:10,output:3}}; return;
    }
    if (request.modelId === 'chat') {
      const prior = request.messages.find(m => m.role === 'assistant');
      if (!prior.content.some(c => c.thinkingSignature === 'vendor-signed-thinking')) throw new Error('signature lost');
      const result = request.messages.find(m => m.role === 'toolResult');
      if (result.isError) throw new Error('tool failed');
    }
    yield {type:'text',delta:request.modelId === 'delegate' ? 'delegate report' : 'read complete'};
    yield {type:'done',stopReason:'stop',usage:{input:20,output:5}};
  },
  images: async (request, context) => {
    if (context.signal.aborted) throw new Error('aborted');
    if (request.input.some(part => part.type === 'image' && part.data !== '${png}')) throw new Error('reference corrupted');
    return {images:[{type:'image',mimeType:'image/png',data:'${png}'}]};
  }
} } };`;
async function setup(t, grants = ["provider.register", "provider.inference"]) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-inference-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: row.ownerPluginId, name: "Fixture", version: "1.0.0", main: "main.cjs",
    permissions: ["provider.register", "provider.inference"], contributes: { providers: [
      { id: "gateway", name: "Gateway", authKind: "api_key", adapter: { version: 1, chat: true, images: true },
        models: row.models.map(m => ({ id: m.id, ...(m.id === "image" ? { operations: ["images"] } : {}) })) },
      { id: "native", name: "Native", models: [{ id: "native-model" }] },
    ] } }));
  await writeFile(join(dir, "main.cjs"), fixture);
  const children = [];
  const plugins = new PluginRuntime({ hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      return { postMessage: message => child.connected && child.send(message), onMessage: h => child.on("message", h),
        onExit: h => child.on("exit", code => h(code ?? 0)), kill: () => child.kill() };
    } });
  const cleanupErrors = [];
  const credentialCalls = [];
  const broker = new PluginProviderInferenceBroker({ plugins, credential: async id => {
    credentialCalls.push(id);
    assert.equal(id, row.id); return { apiKey: "only-own-key" };
  }, reportError: error => cleanupErrors.push(error) });
  t.after(async () => { broker.clear(); for (const loaded of plugins.listLoaded()) await plugins.unload(loaded.manifest.id); for (const child of children) child.kill(); await rm(dir, { recursive: true, force: true }); });
  await plugins.loadFromPath(dir, grants);
  const provider = modelId => {
    const pluginInference = plugins.providerInferenceBinding(row, "chat", modelId);
    return withPluginProviderInference("session", { id: row.id, name: row.name, modelId, apiKey: "", authKind: row.authKind,
      supportsReasoning: false, supportedThinkingLevels: ["off"], pluginInference }, { call: async (method, params) => {
      assert.equal(method, "provider.inference");
      return broker.call(params, { providerId: row.id, modelId, adapter: pluginInference });
    } });
  };
  return { plugins, broker, provider, dir, credentialCalls };
}

test("native session streams signed thinking/tool calls through an isolated plugin, executes tools in Host and resumes", { timeout: 20_000 }, async t => {
  const { provider } = await setup(t);
  const events = [];
  const executed = [];
  const runtime = new DesktopAgentRuntime({ sessionId: "session", mode: "agent", provider: provider("chat"), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async (method, params) => {
      if (method === "tools.execute") { executed.push(params); return { ok: true, content: "fixture contents" }; }
      if (method === "tools.list") return { tools: [] };
      if (method === "project.instructions.resolve") return { entries: [] };
      return {};
    } }, onEvent: event => events.push(event) });
  t.after(() => runtime.dispose());
  await runtime.prompt("Read fixture.txt and report.", "user-1", "turn-1");
  assert.equal(executed.length, 1, JSON.stringify(events));
  assert.equal(executed[0].toolName, "Read");
  assert.ok(events.some(e => e.event.type === "tool_end"));
  assert.ok(JSON.stringify(events).includes("read complete"));
});

test("configured delegate uses the same adapter binding rather than native compatible HTTP", { timeout: 15_000 }, async t => {
  const { provider } = await setup(t);
  const result = await new SubagentRun({ sessionId: "session", parentToolCallId: "task-1", task: "Report", provider: provider("delegate"),
    thinkingLevel: "off", systemPrompt: "Report", tools: [], onEvent: () => undefined,
    definition: { name: "fixture", description: "Fixture", tools: [], prompt: "Report", source: "builtin" } }).run();
  assert.equal(result.status, "completed");
  assert.equal(result.report, "delegate report");
});

test("GenerateImages routes generation and edit references through the plugin and writes only validated scratch output", { timeout: 15_000 }, async t => {
  const { broker, dir } = await setup(t);
  const host = { call: async method => {
    if (method === "settings.get") return { imageGeneration: { providerId: row.id, modelId: "image" } };
    if (method === "providers.get") return { provider: row };
    if (method === "session.getScratchPath") return { path: join(dir, "scratch", "session") };
    if (method === "session.get") return { session: {} };
    throw new Error(`Unexpected Host call: ${method}`);
  } };
  const tool = createImageGenerationTool({ dataDir: dir, getHost: () => host, resolveProviderImages: (provider, id) => broker.images(provider, id),
    fetchImpl: () => { throw new Error("No network/download allowed"); } });
  const invoke = args => tool({ sessionId: "session", toolCallId: "images-1", args, signal: new AbortController().signal });
  const generated = await invoke({ items: [{ prompt: "cover" }] });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const path = generated.content.results[0].path;
  assert.deepEqual(await readFile(path), Buffer.from(png, "base64"));
  const edited = await invoke({ items: [{ prompt: "edit", images: [path] }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
});

test("grant, owner, operation, malformed output, cancellation and unload are fail-closed", { timeout: 15_000 }, async t => {
  const denied = await setup(t, ["provider.register"]);
  assert.throws(() => denied.plugins.providerInferenceBinding(row), /provider.inference/);
  const { plugins, provider, broker } = await setup(t);
  assert.equal(plugins.providerInferenceBinding({ id: "plugin:fixture.inference:native", ownerPluginId: row.ownerPluginId }), undefined);
  assert.throws(() => plugins.providerInferenceBinding(row, "chat", "image"), /operation/);
  assert.throws(() => plugins.providerInferenceBinding({ ...row, id: "plugin:peer.plugin:gateway" }), /match/);
  const malformed = provider("malformed");
  const model = buildProviderModel(malformed);
  const result = await createProviderModels(malformed, model).streamSimple(model, { messages: [{ role: "user", content: "go", timestamp: 1 }] }).result();
  assert.equal(result.stopReason, "error");
  const blocked = provider("blocked");
  const blockedModel = buildProviderModel(blocked);
  const abort = new AbortController();
  const stream = createProviderModels(blocked, blockedModel).streamSimple(blockedModel, { messages: [] }, { signal: abort.signal });
  for await (const event of stream) if (event.type === "text_delta") { abort.abort(); break; }
  assert.equal((await stream.result()).stopReason, "aborted");
  const adapter = plugins.providerInferenceBinding(row, "chat", "blocked");
  const bound = { providerId: row.id, modelId: "blocked", adapter };
  const base = { sessionId: "session", providerId: row.id, modelId: "blocked" };
  const opened = await broker.call({ ...base, operation: "open", request: { version: 1, providerId: "gateway", modelId: "blocked", messages: [] } }, bound);
  await broker.call({ ...base, ...opened, operation: "next" }, bound);
  const pending = broker.call({ ...base, ...opened, operation: "next" }, bound);
  const rejected = assert.rejects(pending);
  await plugins.unload(row.ownerPluginId);
  await rejected;
  await assert.rejects(plugins.invokeProviderInference(adapter, "next", opened));
});

test("native launch authorizes exact main/delegate model bindings, excludes image-only models, and sends no custom credential to sidecar", { timeout: 15_000 }, async t => {
  const { plugins, dir } = await setup(t);
  const priorHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; });
  const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
  const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
  const authorized = [];
  const host = { isAvailable: () => true, call: async method => {
    if (method === "commandShells.list") {
      const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
      return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
    }
    if (method === "providers.list") return { providers: [row] };
    if (method === "skills.disabledBuiltins" || method === "agents.disabledBuiltins") return { disabled: [] };
    if (method === "skills.active") return { skills: [] };
    if (method === "mcp.active") return { servers: [] };
    if (method === "agents.active") return { subagents: [] };
    if (method === "project.group.context") return { context: null };
    if (method === "providers.getSecret") throw new Error("Custom credentials must never enter the sidecar launch payload");
    throw new Error(`Unexpected Host call: ${method}`);
  } };
  const catalog = { ensureLoaded: async () => undefined, configureAccount: () => undefined, findModel: () => undefined,
    modelConfigFor: (query, config) => config ?? genericModelConfig(query.modelId, "") };
  const providerCatalog = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog: catalog });
  const launch = createSessionLaunchRuntime({ runtimeState: { host, sidecar: {
    setProviderInferenceBindings: (sessionId, bindings) => authorized.push({ sessionId, bindings }), setVendorAuthBindings: () => undefined,
  } }, logger: { app: () => undefined }, userMcp: { setRecords: () => undefined, toolsForProject: async () => [] },
    plugins, sessionProjects: new Map(), dataDir: dir, vendorOAuth: { bindingFor: async () => { throw new Error("No native OAuth fallback"); } },
    modelsDevCatalog: catalog, getWorkspacePath: () => null, pluginActiveInProject: () => true,
    bindingForModel: providerCatalog.bindingForModel, effectiveSubagentModelConfig: providerCatalog.effectiveSubagentModelConfig,
    normalizeThinkingLevel: () => "off" });
  const result = await launch.resolveAgentRuntimeLaunch("session", { providerId: row.id, modelId: "chat", projectPath: dir }, {});
  assert.equal(result.sidecarParams.provider.apiKey, "");
  assert.equal(result.sidecarParams.provider.pluginInference.pluginId, row.ownerPluginId);
  assert.ok(authorized[0].bindings.some(binding => binding.modelId === "chat"));
  assert.ok(authorized[0].bindings.some(binding => binding.modelId === "delegate"));
  assert.ok(!authorized[0].bindings.some(binding => binding.modelId === "image"));
  assert.ok(!result.sidecarParams.subagentModelKeys.some(key => key.endsWith("/image")));
  await assert.rejects(launch.resolveAgentRuntimeLaunch("session", { providerId: row.id, modelId: "image", projectPath: dir }, {}), /operation/);
});

test("custom invocation failures never trigger infinite retry or a configured paid fallback", { timeout: 15_000 }, async t => {
  const { provider, credentialCalls } = await setup(t);
  const runtime = new DesktopAgentRuntime({ sessionId: "session", mode: "agent", provider: provider("malformed"), thinkingLevel: "off", infiniteProviderRetry: true,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async () => ({}) }, onEvent: () => undefined });
  t.after(() => runtime.dispose());
  await runtime.prompt("Respond", "user-1", "turn-1");
  assert.equal(credentialCalls.length, 1);
  const result = await new SubagentRun({ sessionId: "session", parentToolCallId: "task-1", task: "Report", provider: provider("malformed"),
    infiniteProviderRetry: true, fallbackModels: [{ key: "delegate", provider: provider("delegate") }],
    thinkingLevel: "off", systemPrompt: "Report", tools: [], onEvent: () => undefined,
    definition: { name: "fixture", description: "Fixture", tools: [], prompt: "Report", source: "builtin" } }).run();
  assert.equal(result.status, "failed");
  assert.equal(credentialCalls.length, 2);
});

test("inference grants are presented as high risk in native plugin review", async () => {
  const { permissionRisk } = await import("../src/features/plugins/model.ts");
  assert.equal(permissionRisk("provider.inference"), "high");
});
