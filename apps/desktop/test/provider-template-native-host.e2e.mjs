import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "../../../scripts/e2e/host.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { VendorOAuth, secretRefForProviderOauth } = await import("../electron/main/oauth.ts");
const { PluginProviderInferenceBroker } = await import("../electron/main/plugin-provider-inference.ts");
const { createImageGenerationTool } = await import("../electron/main/services/image-generation-service.ts");
const { DesktopAgentRuntime } = await import("../../../packages/agent-runtime/dist/runtime.js");
const { SubagentRun } = await import("../../../packages/agent-runtime/dist/subagent.js");
const { withPluginProviderInference } = await import("../../../packages/agent-runtime/dist/plugin-provider-inference.js");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";

test("real Rust Host and plugin child preserve independent native accounts through use, restart and uninstall", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "template-native-host-"));
  const pluginPath = join(root, "plugin"), dataDir = join(root, "data");
  const pluginId = "fixture.native_accounts", vendorId = `plugin-template:${pluginId}:gateway`;
  const permissions = ["provider.register", "provider.oauth", "provider.inference"];
  const host = new Host(resolveHostBinary(), dataDir);
  const children = [], events = [];
  let oauth, terminal, broker;
  const plugins = new PluginRuntime({ hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: ({ entry }) => { const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(child);
      return { postMessage: m => child.connected && child.send(m), onMessage: fn => child.on("message", fn), onExit: fn => child.on("exit", code => fn(code ?? 0)), kill: () => child.kill() }; },
    providerOAuthPrompt: (...args) => oauth.promptPluginOAuth(...args), providerOAuthNotify: (...args) => oauth.notifyPluginOAuth(...args) });
  t.after(async () => { broker?.clear(); for (const p of plugins.listLoaded()) await plugins.unload(p.manifest.id); children.forEach(c => c.kill()); await host.stop(); await rm(root, { recursive: true, force: true }); });
  await mkdir(pluginPath);
  await writeFile(join(pluginPath, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: pluginId, name: "Native account fixture", version: "1.0.0", main: "main.cjs", permissions,
    contributes: { providerTemplates: [{ version: 1, id: "gateway", name: "Fixture gateway", authKind: "oauth", baseUrl: "https://api.example.test/v1",
      adapter: { version: 1, chat: true, images: true }, models: [{ id: "chat", operations: ["chat"] }, { id: "image", operations: ["images"] }] }] } }));
  await writeFile(join(pluginPath, "main.cjs"), `module.exports={
    async onProviderOAuth(r){return {accessToken:'synthetic-access-'+r.accountId,refreshToken:'synthetic-refresh-'+r.accountId,expiresAt:Date.now()+3600000};},
    providerAdapters:{gateway:{version:1,async *chat(r,c){if(!c.credential.apiKey.startsWith('synthetic-access-'))throw new Error('wrong scoped access');yield {type:'text',delta:'native account response'};yield {type:'done',stopReason:'stop',usage:{input:1,output:1}};},
      async images(){return {images:[{type:'image',mimeType:'image/png',data:'${png}'}]};}}}};`);
  await host.start();
  await host.call("plugins.loadDev", { path: pluginPath });
  assert.deepEqual((await host.call("providers.list")).providers, [], "installation must not allocate accounts");
  await plugins.loadFromPath(pluginPath, permissions);
  oauth = new VendorOAuth({ call: (m, p) => host.call(m, p), getPluginOAuthBridge: () => plugins, openExternal: async () => { throw new Error("No network"); },
    emit: e => { events.push(e); if (["done", "error", "cancelled"].includes(e.kind)) terminal?.resolve(e); } });
  const login = async id => { terminal = Promise.withResolvers(); await oauth.start(id); const e = await terminal.promise; assert.equal(e.kind, "done", JSON.stringify(e)); return e.providerId; };
  const a = await login(vendorId), b = await login(vendorId);
  assert.notEqual(a, b);
  await host.call("providers.update", { id: a, name: "First", models: [] });
  await host.call("providers.update", { id: b, name: "Second", models: [{ id: "chat", alias: "Chat alias", availableForSubagents: true }, { id: "image" }] });
  assert.equal(await login(b), b, "reauth must not create a third account");
  const secretA = await host.call("secrets.getForRuntime", { secretRef: secretRefForProviderOauth(a) });
  const credentialB = JSON.parse((await host.call("secrets.getForRuntime", { secretRef: secretRefForProviderOauth(b) })).value);
  credentialB.expiresAt = 1;
  await host.call("secrets.set", { secretRef: secretRefForProviderOauth(b), value: JSON.stringify(credentialB) });
  assert.equal((await oauth.resolveAuth(b)).apiKey, `synthetic-access-${b}`);
  assert.deepEqual(await host.call("secrets.getForRuntime", { secretRef: secretRefForProviderOauth(a) }), secretA);
  assert.equal((await host.call("providers.list")).providers.length, 2);
  const row = (await host.call("providers.get", { id: b })).provider;
  assert.equal(row.pluginTemplateId, "gateway");
  assert.equal(row.pluginTemplateVersion, 1);
  broker = new PluginProviderInferenceBroker({ plugins, credential: id => oauth.resolvePluginInferenceCredential(id), reportError: () => {} });
  const adapter = plugins.providerInferenceBinding(row, "chat", "chat");
  const provider = withPluginProviderInference("session", { id: b, name: row.name, modelId: "chat", apiKey: "", authKind: "oauth", supportsReasoning: false, supportedThinkingLevels: ["off"], pluginInference: adapter },
    { call: (_m, p) => broker.call(p, { providerId: b, modelId: "chat", adapter }) });
  const output = [];
  const runtime = new DesktopAgentRuntime({ sessionId: "session", mode: "agent", provider, thinkingLevel: "off", commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, host: { call: async m => m === "tools.list" ? { tools: [] } : {} }, onEvent: e => output.push(e) });
  t.after(() => runtime.dispose());
  await runtime.prompt("Report", "user", "turn");
  assert.ok(JSON.stringify(output).includes("native account response"));
  assert.ok(output.some(e => e.event.type === "message_end" && e.event.message?.status === "complete"), JSON.stringify(output));
  const delegate = await new SubagentRun({ sessionId: "session", parentToolCallId: "task", task: "Report", provider, thinkingLevel: "off", systemPrompt: "Report", tools: [], onEvent: () => {}, definition: { name: "fixture", description: "Fixture", tools: [], prompt: "Report", source: "builtin" } }).run();
  assert.equal(delegate.status, "completed", JSON.stringify(delegate));
  const { session } = await host.call("session.create", { title: "History survives uninstall" });
  await host.call("settings.set", { imageGeneration: { providerId: b, modelId: "image" } });
  const generate = createImageGenerationTool({ dataDir, getHost: () => host, resolveProviderImages: (p, m) => broker.images(p, m), fetchImpl: () => { throw new Error("No network"); } });
  const image = await generate({ sessionId: session.id, toolCallId: "image", args: { items: [{ prompt: "cover" }] }, signal: new AbortController().signal });
  assert.equal(image.ok, true, JSON.stringify(image));
  assert.deepEqual(await readFile(image.content.results[0].path), Buffer.from(png, "base64"));
  await oauth.deleteAccount(a);
  assert.equal((await host.call("providers.get", { id: a })).provider, null);
  await host.restart();
  const retained = (await host.call("providers.list")).providers;
  assert.equal(retained.length, 1); assert.equal(retained[0].id, b); assert.equal(retained[0].name, "Second");
  assert.equal(retained[0].models[0].alias, "Chat alias");
  assert.ok((await oauth.listVendors()).some(v => v.vendorId === vendorId));
  assert.equal((await oauth.resolveAuth(b)).apiKey, `synthetic-access-${b}`);
  await plugins.unload(pluginId);
  await host.call("plugins.uninstall", { id: pluginId });
  assert.deepEqual((await host.call("providers.list")).providers, []);
  assert.ok(!(await host.call("secrets.getForRuntime", { secretRef: secretRefForProviderOauth(b) })).value);
  assert.equal((await host.call("session.get", { id: session.id })).session.id, session.id);
  assert.ok(!JSON.stringify(events).includes("synthetic-access-"));
  assert.ok(!JSON.stringify(events).includes("synthetic-refresh-"));
});
