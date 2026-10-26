// Audit probes: passing means the documented current risks/limitations were reproduced.
// These are not product security acceptance gates. No network or real credentials.
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { register } from "node:module";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const file = relative => pathToFileURL(join(root, relative));
register(file("apps/desktop/test/helpers/ts-import-hooks.mjs"));
const { PluginRuntime } = await import(file("apps/desktop/electron/main/plugin-runtime.ts"));
const { pluginChildEnv } = await import(file("apps/desktop/electron/main/child-process-env.ts"));
const { validateManifest } = await import(file("packages/plugin-sdk/dist/index.js"));

function makeRuntime(children, services = {}) {
  return new PluginRuntime({ ...services,
    hostEntry: join(root, "apps/desktop/electron/main/plugin-host-process.mjs"),
    spawnProcess: ({ entry, pluginId }) => {
      const child = fork(entry, [], { env: pluginChildEnv(pluginId), stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.push(child);
      return { postMessage: message => child.connected && child.send(message),
        onMessage: handler => child.on("message", handler),
        onExit: handler => child.on("exit", code => handler(code ?? 0)), kill: () => child.kill() };
    },
  });
}
async function cleanup(runtime, children, dir) {
  try {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  } finally {
    for (const child of children) child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

test("provider declaration validates known fields but currently accepts unknown fields", () => {
  const manifest = {
    schemaVersion: 1, id: "audit.fields", name: "Audit fixture", version: "1.0.0", main: "main.cjs",
    permissions: ["provider.register"], contributes: { providers: [{
      id: "gateway", name: "Fixture", authKind: "none", models: [{ id: "chat" }],
      ownerPluginId: "audit.foreign", secretRef: "fake-secret-ref", unknownField: "fixture-only",
    }] },
  };
  const accepted = validateManifest(manifest);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const invalid = structuredClone(manifest);
  invalid.contributes.providers[0].authKind = "unsupported-auth";
  assert.equal(validateManifest(invalid).ok, false);
});

test("trusted plugin with no grants is denied Host file API but retains raw Node file access", { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(scratch, "provider-audit-probe-"));
  const pluginDir = join(dir, "plugin");
  await mkdir(pluginDir);
  const marker = join(dir, "fake-private-marker.txt");
  const result = join(dir, "probe-result.json");
  const output = join(dir, "raw-write.txt");
  await writeFile(marker, "fixture-only-no-real-secret");
  await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "audit.raw-node", name: "Audit fixture", version: "1.0.0", main: "main.cjs", permissions: [],
  }));
  await writeFile(join(pluginDir, "main.cjs"), `
const fs = require('node:fs');
module.exports = { async onLoad() {
  let hostDenied = false;
  try { await pi.fs.readText(${JSON.stringify(marker)}); }
  catch (error) { hostDenied = error.code === 'PERMISSION_DENIED' || String(error.message).includes('fs.read'); }
  const rawRead = fs.readFileSync(${JSON.stringify(marker)}, 'utf8');
  fs.writeFileSync(${JSON.stringify(output)}, 'fixture-write');
  fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ hostDenied, rawRead }));
} };`);
  const children = [];
  const runtime = makeRuntime(children, { getWorkspacePath: () => dir });
  t.after(() => cleanup(runtime, children, dir));
  await runtime.loadFromPath(pluginDir, []);
  assert.deepEqual(JSON.parse(await readFile(result, "utf8")), { hostDenied: true, rawRead: "fixture-only-no-real-secret" });
  assert.equal(await readFile(output, "utf8"), "fixture-write");
});

test("adapter exception text can carry its scoped access token into the Agent error message", { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(scratch, "provider-audit-error-"));
  const permissions = ["provider.register", "provider.inference"];
  const id = "plugin:audit.error:gateway";
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "audit.error", name: "Audit fixture", version: "1.0.0", main: "main.cjs", permissions,
    contributes: { providers: [{ id: "gateway", name: "Fixture", authKind: "api_key", models: [{ id: "chat" }], adapter: { version: 1, chat: true } }] } }));
  await writeFile(join(dir, "main.cjs"), `module.exports = { providerAdapters: { gateway: { version: 1,
    async *chat(request, context) { throw new Error('upstream exception: ' + context.credential.apiKey); }
  } } };`);
  const children = [];
  const runtime = makeRuntime(children);
  const { PluginProviderInferenceBroker } = await import(file("apps/desktop/electron/main/plugin-provider-inference.ts"));
  const { buildProviderModel, createProviderModels } = await import(file("packages/agent-runtime/dist/provider-binding.js"));
  const { withPluginProviderInference } = await import(file("packages/agent-runtime/dist/plugin-provider-inference.js"));
  const fakeKey = "fixture-access-not-real";
  const broker = new PluginProviderInferenceBroker({ plugins: runtime, credential: async () => ({ apiKey: fakeKey }), reportError: () => undefined });
  t.after(async () => { broker.clear(); await cleanup(runtime, children, dir); });
  await runtime.loadFromPath(dir, permissions);
  const binding = runtime.providerInferenceBinding({ id, ownerPluginId: "audit.error" }, "chat", "chat");
  const provider = withPluginProviderInference("audit-session", { id, name: "Audit fixture", modelId: "chat", authKind: "api_key", apiKey: "",
    supportsReasoning: false, supportedThinkingLevels: ["off"], pluginInference: binding },
    { call: async (_method, params) => broker.call(params, { providerId: id, modelId: "chat", adapter: binding }) });
  const model = buildProviderModel(provider);
  const result = await createProviderModels(provider, model).streamSimple(model, { messages: [] }).result();
  assert.equal(result.stopReason, "error");
  assert.ok(result.errorMessage.includes(fakeKey), "probe expected current raw-error exposure");
});
