/**
 * Contract test for the custom-model library lookup.
 *
 * A hand-typed custom id exists nowhere in any provider's list, so the settings
 * picker reads the local models.dev snapshot through one dedicated channel.
 * This pins the handler contract: it loads the snapshot, resolves the id,
 * echoes the provider back on the record, answers a miss with `null`, and never
 * touches the host or the network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import * as modelsDev from "../electron/main/models-dev-catalog.ts";

/** Minimal CJS loader for the main-process module under test. */
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const fixture = {
  anthropic: {
    name: "Anthropic",
    api: "https://api.anthropic.com",
    models: {
      "claude-opus-4.6": {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  },
};

async function fixtureCatalog(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-lookup-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(fixture), "utf8");
  const catalog = new modelsDev.ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

/**
 * Register the real handler with a fake catalog and a fake registrar, then
 * expose only the lookup channel.
 */
function harness(realCatalog) {
  const handlers = new Map();
  const catalogCalls = [];
  const hostCalls = [];
  const modelsDevCatalog = {
    ensureLoaded: async () => {
      catalogCalls.push("ensureLoaded");
      return realCatalog.ensureLoaded();
    },
    findModel: (input) => {
      catalogCalls.push(["findModel", input]);
      return realCatalog.findModel(input);
    },
    vendorProviderKeyForModel: (input) => realCatalog.vendorProviderKeyForModel(input),
  };
  const { registerProviderIpc } = load("../electron/main/ipc/provider-ipc.ts", {
    "@pi-desktop/shared": {
      IPC,
      ErrorCodes,
      inferEndpointProfile: () => undefined,
      normalizeApiStyle: (value) => value ?? "chat_completions",
      resolveBindingLimits: () => ({}),
    },
    "../oauth": { OAUTH_AUTH_KIND: "oauth" },
    "../model-discovery": {
      probeModelList: async () => {
        throw new Error("the lookup must not probe the network");
      },
    },
    "../provider-endpoint-probe": {
      // The lookup handler is a snapshot read: any sweep it started would take
      // the network path this test exists to rule out.
      probeDiscoveryCandidates: async () => {
        throw new Error("the lookup must not probe the network");
      },
    },
    "@pi-desktop/agent-runtime": {},
    "../models-dev-catalog": modelsDev,
    "../host-process": {},
    "../logger": { app: () => {} },
    "./types": {},
  });
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        hostCalls.push(method);
        throw new Error("the lookup must not call the host");
      },
    }),
    modelsDevCatalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [],
    enrichProviderList: async (result) => result,
    bindingForModel: () => undefined,
  });
  const handler = handlers.get(IPC.invoke.providersLookupModel);
  assert.equal(typeof handler, "function", "lookup handler is not registered");
  return { call: (input) => handler(input), catalogCalls, hostCalls };
}

test("a published id returns the snapshot record for the typed id", async (t) => {
  const h = harness(await fixtureCatalog(t));
  const result = await h.call({
    modelId: "Claude-Opus-4.6",
    providerId: "provider-1",
    vendorKey: "anthropic",
  });
  assert.ok(result.info, "a published id must return its record");
  assert.equal(result.info.modelId, "claude-opus-4.6");
  assert.equal(result.info.providerId, "provider-1");
  assert.equal(result.info.contextWindow, 1_000_000);
  assert.equal(result.info.maxTokens, 128_000);
  for (const level of ["low", "medium", "high"]) {
    assert.ok(result.info.supportedThinkingLevels.includes(level));
  }
  // Snapshot read: load then resolve, in that order, and nothing else.
  assert.deepEqual(h.catalogCalls[0], "ensureLoaded");
  assert.equal(h.catalogCalls[1][0], "findModel");
  assert.deepEqual(h.catalogCalls[1][1], {
    vendorKey: "anthropic",
    baseUrl: undefined,
    modelId: "Claude-Opus-4.6",
  });
  assert.deepEqual(h.hostCalls, []);
});

test("an id the library does not publish answers null", async (t) => {
  const h = harness(await fixtureCatalog(t));
  const result = await h.call({ modelId: "not-in-the-library" });
  assert.deepEqual(result, { info: null });
  assert.equal(h.catalogCalls[0], "ensureLoaded");
  assert.deepEqual(h.hostCalls, []);
});

test("a blank id answers null without loading or resolving", async (t) => {
  const h = harness(await fixtureCatalog(t));
  assert.deepEqual(await h.call({ modelId: "   " }), { info: null });
  assert.deepEqual(h.catalogCalls, []);
  assert.deepEqual(h.hostCalls, []);
});

test("the catalog lookup never probes the provider or the host", async (t) => {
  // The fake discovery throws and the fake host records, so any network or
  // host path taken by the handler fails this test instead of passing silently.
  const h = harness(await fixtureCatalog(t));
  await h.call({ modelId: "claude-opus-4.6" });
  await h.call({ modelId: "missing" });
  assert.deepEqual(h.hostCalls, []);
});
