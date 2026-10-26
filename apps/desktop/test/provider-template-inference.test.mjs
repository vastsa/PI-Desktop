import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginProviderInferenceBroker } = await import("../electron/main/plugin-provider-inference.ts");
const { pluginProviderCatalogEntries } = await import("../electron/main/plugin-provider-catalog.ts");

async function setup(t) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "template-inference-"));
  const manifest = { schemaVersion: 1, id: "fixture.templates", name: "Templates", version: "1.0.0", main: "main.cjs",
    permissions: ["provider.register", "provider.inference"], contributes: { providerTemplates: [{ version: 1, id: "gateway", name: "Gateway",
      baseUrl: "https://api.example.test/v1", authKind: "api_key", apiStyle: "chat_completions",
      adapter: { version: 1, chat: true, images: true }, models: [{ id: "chat" }, { id: "image", operations: ["images"] }] }] } };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "main.cjs"), `module.exports = { providerAdapters: { gateway: { version: 1,
    chat: async function* (request, context) {
      if (context.credential.apiKey === 'synthetic-private-error') throw new Error(context.credential.apiKey);
      yield {type:'text',delta:context.credential.apiKey}; yield {type:'done',stopReason:'stop',usage:{input:1,output:1}};
    }, images: async () => ({images:[]})
  } } };`);
  const children = [];
  const plugins = new PluginRuntime({ hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: ({ entry }) => { const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(child);
      return { postMessage: m => child.connected && child.send(m), onMessage: h => child.on("message", h), onExit: h => child.on("exit", c => h(c ?? 0)), kill: () => child.kill() }; } });
  const errors = [];
  const credentials = new Map([["account-a", "key-a"], ["account-b", "key-b"]]);
  const broker = new PluginProviderInferenceBroker({ plugins, credential: async id => ({ apiKey: credentials.get(id) }), reportError: e => errors.push(e) });
  t.after(async () => { broker.clear(); for (const p of plugins.listLoaded()) await plugins.unload(p.manifest.id); children.forEach(c => c.kill()); await rm(dir, { recursive: true, force: true }); });
  await plugins.loadFromPath(dir, manifest.permissions);
  const row = id => ({ id, ownerPluginId: manifest.id, pluginTemplateId: "gateway", pluginTemplateVersion: 1 });
  const binding = id => ({ providerId: id, modelId: "chat", adapter: plugins.providerInferenceBinding(row(id), "chat", "chat") });
  const open = async id => {
    const bound = binding(id);
    const result = await broker.call({ operation: "open", sessionId: "session", request: { version: 1, providerId: "gateway", modelId: "chat", messages: [] } }, bound);
    return { bound, invocationId: result.invocationId };
  };
  return { plugins, broker, credentials, errors, binding, open, manifest };
}

test("template catalog is independent of account rows and keeps source metadata", async t => {
  const { plugins } = await setup(t);
  const entries = pluginProviderCatalogEntries(plugins.listLoaded(), "en");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].templateId, "gateway");
  assert.equal(entries[0].providerId, "plugin-template:fixture.templates:gateway");
  assert.equal(entries[0].name, "Gateway");
});

test("two native account IDs share a template without sharing credentials or invocation access", async t => {
  const { broker, open } = await setup(t);
  const a = await open("account-a");
  const b = await open("account-b");
  await assert.rejects(broker.call({ operation: "next", sessionId: "session", invocationId: a.invocationId }, b.bound), /bound/);
  const pull = state => broker.call({ operation: "next", sessionId: "session", invocationId: state.invocationId }, state.bound);
  assert.deepEqual(await pull(a), { type: "text", delta: "key-a" });
  assert.deepEqual(await pull(b), { type: "text", delta: "key-b" });
});

test("adapter exceptions cannot reflect synthetic access credentials through errors or diagnostics", async t => {
  const { broker, open, credentials, errors } = await setup(t);
  credentials.set("account-a", "synthetic-private-error");
  const a = await open("account-a");
  await assert.rejects(broker.call({ operation: "next", sessionId: "session", invocationId: a.invocationId }, a.bound), error => {
    assert.doesNotMatch(String(error), /synthetic-private-error/);
    return true;
  });
  assert.doesNotMatch(errors.map(String).join("\n"), /synthetic-private-error/);
});
