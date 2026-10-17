import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hook = pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")).href;
register(hook);
const { buildImportPayload, importProvidersOverSsh } = await import("../electron/main/remote/remote-provider-sync.ts");
const { createSystemSshTransport } = await import("../electron/main/remote/ssh-transport.ts");
const { startAdminSocket } = await import("../../pi-host/src/admin-socket.ts");
const originalCwd = process.cwd();
before(() => process.chdir(process.env.PI_SCRATCH_DIR ?? tmpdir()));
after(() => process.chdir(originalCwd));
const KEY = "fixture-only-private-api-key";
const model = (id) => ({ id, contextWindow: 160000, contextWindowSource: "user", maxTokens: 8000, maxTokensSource: "catalog", thinkingLevels: ["off", "high", "max"], defaultThinkingLevel: "max", thinkingProtocol: "adaptive", supportsImages: false, supportsDocuments: null, availableForSubagents: true, nativeWebSearch: true });
const provider = (id = "local") => ({
  id, name: "Network models", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", enabled: true,
  baseUrl: "https://models.example/v1", authKind: "api_key", hasSecret: true, models: [model("first"), model("chosen")],
  defaultModelId: "chosen", apiStyle: "pi_messages", headers: { "x-client": "desktop" },
  supportsReasoning: true, supportedThinkingLevels: ["off", "high", "max"], contextWindow: 0, maxOutputTokens: 0, temperature: 0,
  createdAt: "1", updatedAt: "1",
});
const ssh = { host: "fixture.example", remotePort: 4567, version: "fixture" };
const selection = (providers = [provider()]) => ({ providers, providerIds: providers.map((row) => row.id), setDefault: true, getSecret: async () => KEY });

test("selected providers flow through SSH stdin, the CLI, the live socket and host RPC; repeated import stays idempotent", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(process.cwd(), "desktop-provider-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = new Map();
  const secrets = new Map();
  const settings = { unrelated: true };
  const host = { async call(method, params) {
    if (method === "providers.create") {
      const { secretValue, ...input } = params;
      const row = { ...input, id: randomUUID(), enabled: true, hasSecret: Boolean(secretValue), createdAt: "1", updatedAt: "1" };
      rows.set(row.id, row);
      secrets.set(row.id, secretValue);
      return { provider: row };
    }
    if (method === "providers.get") return { provider: rows.get(params.id) ?? null };
    if (method === "providers.getSecret") return { value: secrets.get(params.id) ?? null };
    if (method === "settings.set") { Object.assign(settings, params); return { ok: true }; }
    throw new Error("Unexpected host RPC");
  } };
  const server = await startAdminSocket({ dataDir: dir, getHost: () => host });
  t.after(() => server.close());
  const command = 'node "$HOME/.pi-desktop/pi-host/current/pi-host.js" provider-import';
  const cli = fileURLToPath(new URL("../../pi-host/src/cli.ts", import.meta.url));
  // External SSH edge only: the fixture executes the real CLI with stdin/stdout
  // inherited. No SSH, provider network, runtime or user Desktop is started.
  const flags = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    if (["--loader", "--experimental-loader"].includes(process.execArgv[i])) flags.push(process.execArgv[i], process.execArgv[++i]);
  }
  const fixture = join(dir, "fixture-ssh.cjs");
  await writeFile(fixture, `#!${process.execPath}\nconst {spawn}=require('node:child_process');\nif(process.argv.at(-1)!==${JSON.stringify(command)})process.exit(9);\nconst child=spawn(process.execPath,${JSON.stringify([...flags, "--import", `data:text/javascript,${encodeURIComponent(`import {register} from 'node:module'; register(${JSON.stringify(hook)});`)}`, cli, "provider-import", "--data-dir", dir])},{stdio:'inherit'});\nchild.on('exit',code=>process.exit(code??1));\n`);
  await chmod(fixture, 0o700);
  const selected = selection([provider("first-local"), { ...provider("local-default"), authKind: "none", hasSecret: false }]);
  selected.localDefault = { providerId: "local-default", modelId: "chosen" };
  const payload = await buildImportPayload(selected);
  assert.deepEqual(payload.defaultModel, { sourceId: "local-default", modelId: "chosen" });
  let disposed = 0;
  const buildTransport = (target) => {
    const transport = createSystemSshTransport(target, { binary: fixture });
    return { ...transport, dispose() { disposed++; transport.dispose(); } };
  };
  const summary = await importProvidersOverSsh({ ssh, payload, buildTransport });
  assert.deepEqual(await importProvidersOverSsh({ ssh, payload, buildTransport }), summary);
  assert.equal(rows.size, 2);
  assert.equal(disposed, 2);
  const firstId = summary.imported[0].providerId;
  assert.deepEqual(rows.get(firstId).models, provider().models);
  assert.deepEqual(rows.get(firstId).headers, provider().headers);
  assert.equal(rows.get(firstId).temperature, 0);
  assert.equal(secrets.get(firstId), KEY);
  assert.equal(settings.defaultProviderId, summary.imported[1].providerId);
  assert.equal(settings.defaultModelId, "chosen");
  assert.equal(settings.unrelated, true);
  assert.ok(!JSON.stringify(summary).includes(KEY));
});

test("selection validation excludes OAuth/plugins/CLI/local rows before fetching any key", async () => {
  for (const patch of [{ authKind: "oauth" }, { hasOauth: true }, { ownerPluginId: "p" }, { protocol: "claude-cli" }, { baseUrl: "http://localhost:11434" }]) {
    let reads = 0;
    await assert.rejects(buildImportPayload({ ...selection([provider(), { ...provider("excluded"), ...patch }]), getSecret: async () => { reads++; return KEY; } }), { errorCode: "INVALID_ARGUMENT" });
    assert.equal(reads, 0);
  }
  await assert.rejects(buildImportPayload({ ...selection(), providerIds: [] }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(buildImportPayload({ ...selection(), getSecret: async () => { throw new Error(KEY); } }), (error) => !String(error).includes(KEY));
});

test("preserves zero overrides and snapshots the selection across key retrieval", async () => {
  const row = provider();
  const payload = await buildImportPayload({ ...selection([row]), getSecret: async () => { row.models[0].id = "changed-during-await"; return KEY; } });
  assert.equal(payload.providers[0].input.models[0].id, "first");
  assert.equal(payload.providers[0].input.temperature, 0);
  assert.equal(payload.providers[0].input.contextWindow, 0);
  assert.equal(payload.providers[0].input.maxOutputTokens, 0);
  assert.equal(payload.defaultModel.modelId, "chosen");
  assert.equal((await buildImportPayload({ ...selection(), setDefault: false })).defaultModel, undefined);
  await assert.rejects(buildImportPayload({ ...selection(), localDefault: { providerId: "local", modelId: "missing" } }), { errorCode: "INVALID_ARGUMENT" });
});

test("malformed/secret-bearing remote results and SSH errors never escape; every transport is disposed", async () => {
  const payload = await buildImportPayload(selection());
  for (const result of [
    { code: 0, stdout: `PI_HOST_PROVIDERS {"imported": "${KEY}"}` },
    { code: 0, stdout: `PI_HOST_FAILED {"code":"${KEY}"}` },
    { code: 0, stdout: `PI_HOST_PROVIDERS {"imported":[],"skipped":[],"defaultSet":false,"secretValue":"${KEY}"}` },
    { code: 0, stdout: "x".repeat(65537) },
    { code: 1, stdout: KEY },
    new Error(KEY),
  ]) {
    let disposed = false;
    await assert.rejects(importProvidersOverSsh({ ssh, sshSecret: "fixture-ssh-password", payload, buildTransport(target) {
      assert.equal(target.password, "fixture-ssh-password");
      return { async execWithInput(command, input) { assert.ok(!command.includes(KEY)); assert.equal(JSON.parse(input).providers[0].input.secretValue, KEY); if (result instanceof Error) throw result; return result; }, dispose() { disposed = true; } };
    } }), (error) => error.errorCode === "HOST_UNAVAILABLE" && !String(error).includes(KEY) && !JSON.stringify(error).includes(KEY));
    assert.equal(disposed, true);
  }
});
