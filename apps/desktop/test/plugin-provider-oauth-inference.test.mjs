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
const { VendorOAuth, secretRefForProviderOauth } = await import("../electron/main/oauth.ts");
const { PluginProviderInferenceBroker } = await import("../electron/main/plugin-provider-inference.ts");
const { createImageGenerationTool } = await import("../electron/main/services/image-generation-service.ts");
const { DesktopAgentRuntime } = await import("../../../packages/agent-runtime/dist/runtime.js");
const { SubagentRun } = await import("../../../packages/agent-runtime/dist/subagent.js");
const { withPluginProviderInference } = await import("../../../packages/agent-runtime/dist/plugin-provider-inference.js");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";

test("one plugin OAuth account signs in, refreshes and serves native main/delegate/image paths without exposing refresh tokens", { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-oauth-inference-"));
  const id = "plugin:fixture.oauth:gateway";
  const permissions = ["provider.register", "provider.oauth", "provider.inference"];
  const row = { id, name: "OAuth fixture", ownerPluginId: "fixture.oauth", enabled: true,
    authKind: "oauth", baseUrl: "https://fixture.invalid", vendorKey: "custom", apiStyle: "chat_completions",
    models: ["chat", "image"].map(modelId => ({ id: modelId, contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], availableForSubagents: true })),
    pluginModelOperations: { chat: ["chat"], image: ["images"] }, defaultModelId: "chat" };
  const secrets = new Map();
  const events = [];
  const openedUrls = [];
  const loginDone = Promise.withResolvers();
  const children = [];
  let oauth;
  let broker;
  const host = { call: async (method, params = {}) => {
    if (method === "providers.list") return { providers: [{ ...row, hasOauth: secrets.has(secretRefForProviderOauth(id)) }] };
    if (method === "providers.get") return { provider: { ...row, hasOauth: secrets.has(secretRefForProviderOauth(id)) } };
    if (method === "providers.update") { Object.assign(row, params); return { provider: row }; }
    if (method === "secrets.set") { secrets.set(params.secretRef, params.value); return { ok: true }; }
    if (method === "secrets.getForRuntime") return { value: secrets.get(params.secretRef) };
    if (method === "secrets.delete") { secrets.delete(params.secretRef); return { ok: true }; }
    if (method === "settings.get") return { imageGeneration: { providerId: id, modelId: "image" } };
    if (method === "session.getScratchPath") return { path: join(dir, "scratch", "session") };
    if (method === "session.get") return { session: {} };
    throw new Error(`Unexpected Host boundary: ${method}`);
  } };
  const plugins = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      return { postMessage: message => child.connected && child.send(message), onMessage: handler => child.on("message", handler),
        onExit: handler => child.on("exit", code => handler(code ?? 0)), kill: () => child.kill() };
    },
    providerOAuthNotify: (...args) => oauth.notifyPluginOAuth(...args),
    providerOAuthPrompt: (...args) => oauth.promptPluginOAuth(...args),
  });
  t.after(async () => {
    broker?.clear();
    for (const loaded of plugins.listLoaded()) await plugins.unload(loaded.manifest.id);
    for (const child of children) child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: row.ownerPluginId,
    name: row.name, version: "1.0.0", main: "main.cjs", permissions,
    contributes: { providers: [{ id: "gateway", name: row.name, authKind: "oauth", baseUrl: row.baseUrl,
      adapter: { version: 1, chat: true, images: true },
      models: [{ id: "chat", operations: ["chat"] }, { id: "image", operations: ["images"] }] }] } }));
  await writeFile(join(dir, "main.cjs"), `
function verify(context) {
  const credential = context.credential;
  if (credential.apiKey !== 'refreshed-fixture-access' || credential.requestData?.projectId !== 'fixture-project'
      || 'refreshToken' in credential) throw new Error('invalid scoped inference credential');
}
module.exports = {
  async onProviderOAuth(request) {
    if (request.operation === 'refresh') {
      if (request.credential.refreshToken !== 'fixture-refresh' || request.credential.requestData.projectId !== 'fixture-project') throw new Error('invalid refresh state');
      return {accessToken:'refreshed-fixture-access',expiresAt:Date.now()+3600000};
    }
    await pi.providers.oauth.notify(request.loginId,{kind:'authUrl',url:'https://fixture.invalid/authorize'});
    const code = await pi.providers.oauth.prompt(request.loginId,{type:'manual_code',message:'Paste fixture authorization code'});
    if (code !== 'fixture-code') throw new Error('wrong code');
    return {accessToken:'expired-fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()-1,
      accountLabel:'Fixture account',requestData:{projectId:'fixture-project'}};
  },
  providerAdapters: { gateway: {version:1,
    async *chat(request,context) {verify(context);yield {type:'text',delta:'OAuth report'};yield {type:'done',stopReason:'stop',usage:{input:1,output:2}};},
    async images(request,context) {verify(context);return {images:[{type:'image',mimeType:'image/png',data:'${png}'}]};}
  }}
};`);
  await plugins.loadFromPath(dir, permissions);
  oauth = new VendorOAuth({ call: host.call, getPluginOAuthBridge: () => plugins,
    openExternal: async url => { openedUrls.push(url); }, emit: event => {
      events.push(event);
      if (event.kind === "prompt") queueMicrotask(() => oauth.respond({ loginId: event.loginId, promptId: event.request.promptId, value: "fixture-code" }));
      if (event.kind === "done") loginDone.resolve();
      if (event.kind === "error" || event.kind === "cancelled") loginDone.reject(new Error(`Login ${event.kind}: ${event.code ?? ""}`));
    },
  });
  const vendor = (await oauth.listVendors()).find(candidate => candidate.vendorId === id);
  assert.ok(vendor, "plugin missing from native OAuth vendor list");
  await oauth.start(vendor.vendorId);
  await loginDone.promise;
  assert.equal(openedUrls.length, 1);
  assert.equal(JSON.stringify(events).includes("fixture-refresh"), false);
  broker = new PluginProviderInferenceBroker({ plugins, credential: providerId => oauth.resolvePluginInferenceCredential(providerId), reportError: () => undefined });
  const runtimeProvider = withPluginProviderInference("session", { id, name: row.name, authKind: "oauth", apiKey: "", modelId: "chat",
    supportsReasoning: false, supportedThinkingLevels: ["off"], pluginInference: plugins.providerInferenceBinding(row, "chat", "chat") },
    { call: async (_method, params) => broker.call(params, { providerId: id, modelId: "chat", adapter: runtimeProvider.pluginInference }) });
  assert.equal(JSON.stringify(runtimeProvider).includes("fixture-refresh"), false);
  const runtimeEvents = [];
  const runtime = new DesktopAgentRuntime({ sessionId: "session", mode: "agent", provider: runtimeProvider, thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async method => method === "tools.list" ? { tools: [] } : {} }, onEvent: event => runtimeEvents.push(event) });
  t.after(() => runtime.dispose());
  await runtime.prompt("Report", "user-1", "turn-1");
  assert.ok(JSON.stringify(runtimeEvents).includes("OAuth report"));
  const delegated = await new SubagentRun({ sessionId: "session", parentToolCallId: "task-1", task: "Report", provider: runtimeProvider,
    thinkingLevel: "off", systemPrompt: "Report", tools: [], onEvent: () => undefined,
    definition: { name: "fixture", description: "Fixture", tools: [], prompt: "Report", source: "builtin" } }).run();
  assert.equal(delegated.status, "completed");
  assert.equal(delegated.report, "OAuth report");
  const tool = createImageGenerationTool({ dataDir: dir, getHost: () => host,
    resolveProviderImages: (provider, modelId) => broker.images(provider, modelId),
    fetchImpl: () => { throw new Error("No real network allowed"); } });
  const generated = await tool({ sessionId: "session", toolCallId: "image-1", args: { items: [{ prompt: "cover" }] }, signal: new AbortController().signal });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.deepEqual(await readFile(generated.content.results[0].path), Buffer.from(png, "base64"));
  await oauth.deleteAccount(id);
  assert.equal(secrets.has(secretRefForProviderOauth(id)), false);
  await assert.rejects(oauth.resolvePluginInferenceCredential(id));
});
