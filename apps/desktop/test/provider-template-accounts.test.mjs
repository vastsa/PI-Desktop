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

async function fixture(t) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "template-accounts-"));
  const pluginId = "fixture.accounts";
  const vendorId = `plugin-template:${pluginId}:gateway`;
  const permissions = ["provider.register", "provider.oauth", "provider.inference"];
  const rows = new Map(), secrets = new Map(), children = [], events = [];
  let next = 0, selected, terminal, oauth, broker, answer = "code";
  const host = { call: async (method, p = {}) => {
    const project = row => row && ({ ...row, hasOauth: secrets.has(secretRefForProviderOauth(row.id)) });
    if (method === "providers.list") return { providers: [...rows.values()].map(project) };
    if (method === "providers.get") return { provider: project(rows.get(p.id)) };
    if (method === "providers.createFromTemplate") {
      assert.equal(p.pluginId, pluginId); assert.equal(p.templateId, "gateway");
      const id = `account-${++next}`;
      const row = { id, name: "Template account", ownerPluginId: pluginId, pluginTemplateId: "gateway", pluginTemplateVersion: 1,
        enabled: false, authKind: "oauth", baseUrl: "https://api.example.test/v1", apiStyle: "chat_completions", vendorKey: "custom",
        models: ["chat", "image"].map(id => ({ id, contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: "off", availableForSubagents: true })),
        pluginModelOperations: { chat: ["chat"], image: ["images"] } };
      rows.set(id, row); return { provider: project(row) };
    }
    if (method === "providers.completeTemplateOAuth") { assert.ok(secrets.has(secretRefForProviderOauth(p.id))); rows.get(p.id).enabled = true; return { provider: project(rows.get(p.id)) }; }
    if (method === "providers.delete") { rows.delete(p.id); secrets.delete(secretRefForProviderOauth(p.id)); return { ok: true }; }
    if (method === "providers.update") { Object.assign(rows.get(p.id), p); return { provider: project(rows.get(p.id)) }; }
    if (method === "secrets.set") { secrets.set(p.secretRef, p.value); return { ok: true }; }
    if (method === "secrets.getForRuntime") return { value: secrets.get(p.secretRef) };
    if (method === "secrets.delete") { secrets.delete(p.secretRef); return { ok: true }; }
    if (method === "settings.get") return { imageGeneration: { providerId: selected, modelId: "image" } };
    if (method === "session.getScratchPath") return { path: join(dir, "scratch", "session") };
    if (method === "session.get") return { session: {} };
    throw new Error(`Unexpected Host boundary: ${method}`);
  } };
  const plugins = new PluginRuntime({ hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: ({ entry }) => { const c = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(c);
      return { postMessage: m => c.connected && c.send(m), onMessage: h => c.on("message", h), onExit: h => c.on("exit", code => h(code ?? 0)), kill: () => c.kill() }; },
    providerOAuthPrompt: (...args) => oauth.promptPluginOAuth(...args), providerOAuthNotify: (...args) => oauth.notifyPluginOAuth(...args) });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: pluginId, name: "Fixture templates", version: "1.0.0", main: "main.cjs", permissions,
    contributes: { providerTemplates: [{ version: 1, id: "gateway", name: "Template OAuth", baseUrl: "https://api.example.test/v1", authKind: "oauth",
      adapter: { version: 1, chat: true, images: true }, models: [{ id: "chat", operations: ["chat"] }, { id: "image", operations: ["images"] }] }] } }));
  await writeFile(join(dir, "main.cjs"), `module.exports={
    async onProviderOAuth(request){
      if(request.operation==='refresh') return {accessToken:'fresh-'+request.accountId,expiresAt:Date.now()+3600000};
      const code=await pi.providers.oauth.prompt(request.loginId,{type:'manual_code',message:'Fixture code'});
      if(code==='fail') throw new Error('synthetic-secret-error');
      return {accessToken:'access-'+request.accountId,refreshToken:'refresh-'+request.accountId,expiresAt:Date.now()+3600000,accountLabel:code};
    },providerAdapters:{gateway:{version:1,
      async *chat(request,context){if('refreshToken' in context.credential) throw new Error('refresh exposed');yield {type:'text',delta:context.credential.apiKey};yield {type:'done',stopReason:'stop',usage:{input:1,output:1}};},
      async images(request,context){if(!context.credential.apiKey) throw new Error('missing access');return {images:[{type:'image',mimeType:'image/png',data:'${png}'}]};}
    }}};`);
  await plugins.loadFromPath(dir, permissions);
  oauth = new VendorOAuth({ call: host.call, getPluginOAuthBridge: () => plugins, openExternal: async () => {}, emit: event => {
    events.push(event);
    if (event.kind === "prompt") queueMicrotask(() => oauth.respond({ loginId: event.loginId, promptId: event.request.promptId, ...(answer === undefined ? {} : { value: answer }) }));
    if (["done", "cancelled", "error"].includes(event.kind)) terminal?.resolve(event);
  } });
  broker = new PluginProviderInferenceBroker({ plugins, credential: id => oauth.resolvePluginInferenceCredential(id), reportError: () => {} });
  t.after(async () => { broker.clear(); for (const p of plugins.listLoaded()) await plugins.unload(p.manifest.id); children.forEach(c => c.kill()); await rm(dir, { recursive: true, force: true }); });
  return { dir, host, rows, secrets, events, plugins, oauth, broker, vendorId, select: id => { selected = id; },
    login: async (id = vendorId, code = "code") => { answer = code; terminal = Promise.withResolvers(); await oauth.start(id); return terminal.promise; } };
}

test("reusable OAuth template creates independent accounts and serves native chat/delegate/images", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const a = await f.login(), b = await f.login();
  assert.equal(a.kind, "done"); assert.equal(b.kind, "done"); assert.notEqual(a.providerId, b.providerId);
  assert.equal((await f.oauth.listVendors()).find(v => v.vendorId === f.vendorId).accounts.length, 2);
  const key = id => secretRefForProviderOauth(id);
  for (const id of [a.providerId, b.providerId]) {
    const credential = JSON.parse(f.secrets.get(key(id))); credential.expiresAt = 1; f.secrets.set(key(id), JSON.stringify(credential));
  }
  const auth = await Promise.all([f.oauth.resolvePluginInferenceCredential(a.providerId), f.oauth.resolvePluginInferenceCredential(b.providerId)]);
  assert.deepEqual(auth.map(c => c.apiKey), [`fresh-${a.providerId}`, `fresh-${b.providerId}`]);
  assert.ok(!JSON.stringify(auth).includes("refresh-"));
  const beforeB = f.secrets.get(key(b.providerId));
  const reauth = await f.login(a.providerId);
  assert.equal(reauth.providerId, a.providerId); assert.equal(f.rows.size, 2); assert.equal(f.secrets.get(key(b.providerId)), beforeB);
  const id = a.providerId, row = f.rows.get(id);
  const adapter = f.plugins.providerInferenceBinding(row, "chat", "chat");
  const provider = withPluginProviderInference("session", { id, name: row.name, modelId: "chat", apiKey: "", authKind: "oauth", supportsReasoning: false, supportedThinkingLevels: ["off"], pluginInference: adapter },
    { call: (_m, params) => f.broker.call(params, { providerId: id, modelId: "chat", adapter }) });
  const output = [];
  const runtime = new DesktopAgentRuntime({ sessionId: "session", mode: "agent", provider, thinkingLevel: "off", commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, host: { call: async method => method === "tools.list" ? { tools: [] } : {} }, onEvent: e => output.push(e) });
  t.after(() => runtime.dispose());
  await runtime.prompt("Report", "user", "turn");
  assert.ok(JSON.stringify(output).includes(`access-${id}`));
  const delegated = await new SubagentRun({ sessionId: "session", parentToolCallId: "task", task: "Report", provider, thinkingLevel: "off", systemPrompt: "Report", tools: [], onEvent: () => {}, definition: { name: "fixture", description: "Fixture", tools: [], prompt: "Report", source: "builtin" } }).run();
  assert.equal(delegated.status, "completed", JSON.stringify(delegated)); assert.equal(delegated.report, `access-${id}`);
  f.select(id);
  const generate = createImageGenerationTool({ dataDir: f.dir, getHost: () => f.host, resolveProviderImages: (p, m) => f.broker.images(p, m), fetchImpl: () => { throw new Error("No real network"); } });
  const image = await generate({ sessionId: "session", toolCallId: "image", args: { items: [{ prompt: "cover" }] }, signal: new AbortController().signal });
  assert.equal(image.ok, true, JSON.stringify(image)); assert.deepEqual(await readFile(image.content.results[0].path), Buffer.from(png, "base64"));
  await f.oauth.deleteAccount(id);
  assert.ok(!f.rows.has(id)); assert.ok(!f.secrets.has(key(id))); assert.equal(f.secrets.get(key(b.providerId)), beforeB);
  assert.equal((await f.oauth.listVendors()).find(v => v.vendorId === f.vendorId).accounts.length, 1);
  await assert.rejects(f.oauth.resolveAuth(id));
  assert.ok(!JSON.stringify(f.events).includes("refresh-"));
});

test("failed and cancelled template logins remove only their pending accounts", async t => {
  const f = await fixture(t);
  const a = await f.login();
  assert.equal((await f.login(f.vendorId, "fail")).kind, "error");
  // An absent prompt answer drives the real native cancellation path.
  const pending = Promise.withResolvers();
  const original = f.oauth.respond.bind(f.oauth);
  f.oauth.respond = input => original({ loginId: input.loginId, promptId: input.promptId });
  pending.resolve(await f.login());
  assert.equal((await pending.promise).kind, "cancelled");
  assert.deepEqual([...f.rows.keys()], [a.providerId]);
  assert.equal(f.secrets.size, 1);
  assert.ok(!JSON.stringify(f.events).includes("synthetic-secret-error"));
});

test("disabled or unloaded template accounts never return even unexpired OAuth credentials", async t => {
  const f = await fixture(t);
  const account = await f.login();
  f.rows.get(account.providerId).enabled = false;
  await assert.rejects(f.oauth.resolveAuth(account.providerId));
  f.rows.get(account.providerId).enabled = true;
  await f.plugins.unload("fixture.accounts");
  await assert.rejects(f.oauth.resolveAuth(account.providerId));
});

test("reauthentication restores a template account disabled by credential invalidation without creating another row", async t => {
  const f = await fixture(t);
  const account = await f.login();
  f.rows.get(account.providerId).enabled = false;
  f.secrets.delete(secretRefForProviderOauth(account.providerId));
  await assert.rejects(f.oauth.resolveAuth(account.providerId));
  const result = await f.login(account.providerId);
  assert.equal(result.kind, "done");
  assert.equal(result.providerId, account.providerId);
  assert.equal(f.rows.size, 1);
  assert.equal((await f.oauth.resolveAuth(account.providerId)).apiKey, `access-${account.providerId}`);
});
