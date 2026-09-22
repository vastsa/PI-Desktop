import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createExtensionModelCatalog } = await import(
  "../electron/main/runtime/extension-model-catalog.ts"
);

const fixture = {
  example: {
    name: "Example",
    api: "https://models.example/v1",
    models: {
      "catalog-model": {
        id: "catalog-model",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128_000, output: 8_192 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
};

async function catalogWith(providers, defaults = {}) {
  const modelsDevCatalog = new ModelsDevCatalog({
    catalogPath: "unused-model-catalog.json",
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(await modelsDevCatalog.refresh(), true);
  const host = {
    calls: [],
    call: async (method) => {
      host.calls.push(method);
      if (method === "providers.list") return { providers };
      if (method === "settings.get") return defaults;
      throw new Error(`unexpected host call ${method}`);
    },
  };
  return {
    host,
    catalog: createExtensionModelCatalog({
      getHost: () => host,
      modelsDevCatalog,
    }),
  };
}

/** A stored binding in the shape host-core always returns. */
function binding(id, overrides = {}) {
  return {
    id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ["off"],
    ...overrides,
  };
}

/** A ready provider row. */
function provider(overrides = {}) {
  return {
    id: "provider-one",
    name: "Provider One",
    vendorKey: "example",
    enabled: true,
    baseUrl: "https://models.example/v1",
    authKind: "api_key",
    hasSecret: true,
    hasOauth: false,
    models: [binding("catalog-model")],
    ...overrides,
  };
}

test("projects only ready providers and keeps every descriptor field", async (t) => {
  const disabled = provider({ id: "disabled", name: "Disabled", enabled: false });
  const unconfigured = provider({
    id: "unconfigured",
    name: "Unconfigured",
    hasSecret: false,
    authKind: "api_key",
    models: [binding("unconfigured-model")],
  });
  const { catalog, host } = await catalogWith(
    [
      provider({
        models: [
          binding("catalog-model", {
            alias: "Catalog Alias",
            contextWindow: 64_000,
            maxTokens: 4_096,
            thinkingLevels: ["low", "high"],
            supportsImages: true,
          }),
        ],
      }),
      disabled,
      unconfigured,
    ],
    { defaultProviderId: "provider-one", defaultModelId: "catalog-model" },
  );

  const models = await catalog.listReadyModels();
  assert.deepEqual(host.calls, ["providers.list", "settings.get"]);

  assert.equal(models.length, 1);
  const [model] = models;
  assert.equal(model.providerId, "provider-one");
  assert.equal(model.providerName, "Provider One");
  assert.equal(model.modelId, "catalog-model");
  assert.equal(model.label, "catalog-model (Provider One)");
  assert.equal(model.alias, "Catalog Alias");
  assert.equal(model.baseUrl, "https://models.example/v1");
  assert.equal(model.isDefault, true);
  assert.equal(model.hasSecret, true);
  assert.equal(model.hasOauth, false);
  assert.equal(model.authKind, "api_key");
  assert.equal(model.supportsReasoning, true);
  assert.equal(model.supportsImages, true);
  assert.equal(model.toolCall, true);
  assert.deepEqual(model.thinkingLevels, ["low", "high"]);
  assert.equal(model.contextWindow, 64_000);
  assert.equal(model.maxTokens, 4_096);
  assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.deepEqual(model.modalities, { input: ["text", "image"], output: ["text"] });
  t.diagnostic(`ready models: ${models.map((entry) => entry.modelId).join(",")}`);
});

test("falls back to the provider default model and generic metadata", async () => {
  const { catalog } = await catalogWith([
    provider({
      baseUrl: "http://127.0.0.1:9/v1",
      models: [],
      defaultModelId: "unpublished-model",
      hasSecret: false,
      hasOauth: true,
      authKind: "oauth",
    }),
  ]);

  const [model] = await catalog.listReadyModels();
  assert.equal(model.modelId, "unpublished-model");
  assert.equal(model.baseUrl, "http://127.0.0.1:9/v1");
  assert.equal(model.hasOauth, true);
  assert.equal(model.supportsReasoning, false);
  assert.deepEqual(model.thinkingLevels, ["off"]);
  assert.equal(model.supportsImages, false);
  assert.equal(model.toolCall, false);
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 8_192);
  // The only ready provider is also the default one, so its fallback binding
  // claims the single default slot (listReadyPluginModels order).
  assert.equal(model.isDefault, true);
});

test("accepts a credential-free provider and assigns one default at most", async () => {
  const { catalog } = await catalogWith(
    [
      provider({
        id: "local",
        name: "Local",
        authKind: "none",
        hasSecret: false,
        models: [binding("one"), binding("two"), binding("one")],
      }),
    ],
    { defaultProviderId: "local", defaultModelId: "two" },
  );

  const models = await catalog.listReadyModels();
  // A repeated binding is one descriptor, and only the default match claims it.
  assert.deepEqual(models.map((model) => model.modelId), ["one", "two"]);
  assert.deepEqual(models.map((model) => model.isDefault ?? false), [false, true]);
});

test("carries neither key material nor provider config in the projection", async (t) => {
  const { catalog } = await catalogWith(
    [
      provider({
        headers: { Authorization: "Bearer secret:provider:key" },
        apiKey: "sk-test-secret",
      }),
    ],
    { defaultProviderId: "provider-one", defaultModelId: "catalog-model" },
  );

  const models = await catalog.listReadyModels();
  const serialized = JSON.stringify(models);
  for (const leak of [
    "apiKey",
    "headers",
    "secret:provider:",
    "sk-test-secret",
    "authorization",
    "Bearer",
    "config_json",
  ]) {
    assert.equal(serialized.includes(leak), false, `projection leaked ${leak}`);
  }
  t.diagnostic(`projection fields: ${Object.keys(models[0]).join(",")}`);
});

test("fails closed when no host is available", async () => {
  const catalog = createExtensionModelCatalog({
    getHost: () => null,
    modelsDevCatalog: { ensureLoaded: async () => {}, findModel: () => undefined },
  });
  await assert.rejects(() => catalog.listReadyModels(), /host unavailable/);
});
