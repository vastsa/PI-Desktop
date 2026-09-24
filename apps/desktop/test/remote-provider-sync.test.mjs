import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { buildImportPayload, importProvidersOverSsh, parseImportOutput } = await import(
  "../electron/main/remote/remote-provider-sync.ts"
);

const KEY = "sk-test-secret-value";

function provider(overrides) {
  return {
    id: "p1",
    name: "OpenAI",
    vendorKey: "openai",
    type: "native",
    protocol: "openai-responses",
    enabled: true,
    authKind: "api_key",
    hasSecret: true,
    models: [{ id: "gpt-x" }],
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const SSH = { host: "box", remotePort: 7777, version: "1" };

test("the payload carries the key and the first provider's model as default", async () => {
  const payload = await buildImportPayload({
    providers: [provider(), provider({ id: "p2", name: "Local", authKind: "none", hasSecret: false })],
    providerIds: ["p1", "p2", "p1"],
    setDefault: true,
    getSecret: async (id) => (id === "p1" ? KEY : undefined),
  });
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.providers.map((entry) => entry.sourceId), ["p1", "p2"]);
  assert.equal(payload.providers[0].input.secretValue, KEY);
  assert.equal(payload.providers[1].input.secretValue, undefined);
  assert.deepEqual(payload.defaultModel, { sourceId: "p1", modelId: "gpt-x" });
});

test("the payload refuses ids the renderer should not have offered", async () => {
  const base = { providers: [provider({ ownerPluginId: "plug" })], setDefault: false, getSecret: async () => KEY };
  await assert.rejects(buildImportPayload({ ...base, providerIds: ["p1"] }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(buildImportPayload({ ...base, providerIds: ["missing"] }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(buildImportPayload({ ...base, providerIds: [] }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(
    buildImportPayload({ providers: [provider()], providerIds: ["p1"], setDefault: false, getSecret: async () => undefined }),
    { errorCode: "INVALID_ARGUMENT" },
  );
});

test("the CLI result line is parsed; a failure line becomes a coded error", () => {
  const summary = { imported: [{ sourceId: "p1", providerId: "h1", action: "created" }], skipped: [], defaultSet: true };
  assert.deepEqual(parseImportOutput(`noise\nPI_HOST_PROVIDERS ${JSON.stringify(summary)}\n`), summary);
  assert.throws(() => parseImportOutput('PI_HOST_FAILED {"code":"ADMIN_UNAVAILABLE"}\n'), (error) => {
    assert.equal(error.data.code, "ADMIN_UNAVAILABLE");
    return true;
  });
  assert.throws(() => parseImportOutput("nothing"), { errorCode: "HOST_UNAVAILABLE" });
});

test("the payload travels only on stdin and the transport is disposed", async () => {
  const calls = [];
  let disposed = false;
  const summary = { imported: [], skipped: [], defaultSet: false };
  const result = await importProvidersOverSsh({
    ssh: SSH,
    payload: { version: 1, providers: [{ sourceId: "p1", input: { name: "x", secretValue: KEY } }] },
    buildTransport: (target) => {
      assert.equal(target.host, "box");
      return {
        exec: async () => assert.fail("exec is not used"),
        execWithInput: async (command, input) => {
          calls.push({ command, input });
          return { stdout: `PI_HOST_PROVIDERS ${JSON.stringify(summary)}\n`, stderr: "", code: 0 };
        },
        forward: async () => assert.fail("forward is not used"),
        dispose: () => {
          disposed = true;
        },
      };
    },
  });
  assert.deepEqual(result, summary);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /pi-host\.js" provider-import$/);
  assert.ok(!calls[0].command.includes(KEY));
  assert.ok(calls[0].input.includes(KEY));
  assert.equal(disposed, true);
});

test("a non-zero exit still reports the host's failure code", async () => {
  await assert.rejects(
    importProvidersOverSsh({
      ssh: SSH,
      payload: { version: 1, providers: [] },
      buildTransport: () => ({
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        execWithInput: async () => {
          throw Object.assign(new Error("exit 1"), { stdout: 'PI_HOST_FAILED {"code":"HOST_UNAVAILABLE"}\n' });
        },
        forward: async () => assert.fail(),
        dispose: () => undefined,
      }),
    }),
    (error) => error.data?.code === "HOST_UNAVAILABLE",
  );
});
