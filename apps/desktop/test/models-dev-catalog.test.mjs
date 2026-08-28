import assert from "node:assert/strict";
import test from "node:test";

import {
  MODELS_DEV_API_URL,
  ModelsDevCatalog,
  modelInfoFromModelsDev,
  piModelConfigFromModelsDev,
  parseModelsDevCatalog,
  thinkingLevelsFromModelsDev,
} from "../electron/main/models-dev-catalog.ts";

const catalogFixture = {
  togetherai: {
    name: "Together AI",
    api: "https://api.together.test/v1",
    models: {
      "reasoner-v2": {
        id: "reasoner-v2",
        name: "Reasoner V2",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
        tool_call: true,
        structured_output: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200_000, output: 16_000 },
        cost: { input: 1.2, output: 3.4, cache_read: 0.2 },
      },
      "toggle-v2": {
        id: "toggle-v2",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        modalities: { input: ["text"], output: ["text"] },
      },
      "audio-only": {
        id: "audio-only",
        modalities: { input: ["audio"], output: ["text"] },
      },
      "audio-output": {
        id: "audio-output",
        modalities: { input: ["text"], output: ["audio"] },
      },
      "metadata-sparse": {
        id: "metadata-sparse",
      },
    },
  },
  openai: {
    name: "OpenAI",
    models: {
      "gpt-test": {
        id: "gpt-test",
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

test("models.dev records normalize limits, capabilities, and sparse thinking levels", () => {
  const [provider] = parseModelsDevCatalog(catalogFixture);
  assert.equal(provider.providerKey, "togetherai");
  assert.equal(provider.models.length, 3, "audio-only entries are not chat models");

  const reasoner = provider.models.find((model) => model.modelId === "reasoner-v2");
  assert.deepEqual(reasoner, {
    providerKey: "togetherai",
    providerName: "Together AI",
    providerApi: "https://api.together.test/v1",
    modelId: "reasoner-v2",
    displayName: "Reasoner V2",
    displayNamePublished: true,
    reasoning: true,
    reasoningPublished: true,
    thinkingLevels: ["off", "high", "max"],
    input: ["text", "image"],
    inputPublished: true,
    capabilities: ["text", "tools", "vision", "reasoning", "json"],
    contextWindow: 200_000,
    maxTokens: 16_000,
    cost: { input: 1.2, output: 3.4, cacheRead: 0.2 },
  });

  const info = modelInfoFromModelsDev(reasoner, "provider-row");
  assert.deepEqual(info, {
    modelId: "reasoner-v2",
    displayName: "Reasoner V2",
    providerId: "provider-row",
    contextWindow: 200_000,
    maxTokens: 16_000,
    reasoning: true,
    supportedThinkingLevels: ["off", "high", "max"],
    capabilities: ["text", "tools", "vision", "reasoning", "json"],
    source: "discovered",
    catalogSource: "models.dev",
  });

  const config = piModelConfigFromModelsDev(
    reasoner,
    {
      source: "pi",
      name: "Old name",
      baseUrl: "https://fallback.example",
      reasoning: false,
      input: ["text"],
      cost: { input: 9, output: 10, cacheRead: 1, cacheWrite: 2 },
      contextWindow: 64_000,
      maxTokens: 4_000,
      compat: { thinkingFormat: "deepseek" },
    },
    "https://api.together.test/v1",
  );
  assert.deepEqual(
    {
      source: config.source,
      name: config.name,
      baseUrl: config.baseUrl,
      reasoning: config.reasoning,
      input: config.input,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      cost: config.cost,
      compat: config.compat,
    },
    {
      source: "models.dev",
      name: "Reasoner V2",
      baseUrl: "https://api.together.test/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 16_000,
      cost: { input: 1.2, output: 3.4, cacheRead: 0.2, cacheWrite: 2 },
      compat: { thinkingFormat: "deepseek" },
    },
  );

  const sparse = provider.models.find((model) => model.modelId === "metadata-sparse");
  const sparseConfig = piModelConfigFromModelsDev(
    sparse,
    {
      source: "pi",
      name: "Pi fallback name",
      baseUrl: "https://fallback.example",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 77_000,
      maxTokens: 7_000,
    },
    undefined,
  );
  assert.equal(sparseConfig.name, "Pi fallback name");
  assert.equal(sparseConfig.reasoning, true);
  assert.deepEqual(sparseConfig.input, ["text", "image"]);
  assert.equal(sparseConfig.contextWindow, 77_000);
  assert.equal(sparseConfig.maxTokens, 7_000);
});

test("models.dev reasoning options map to canonical levels", () => {
  assert.deepEqual(
    thinkingLevelsFromModelsDev(true, [
      { type: "effort", values: ["max", "low", "none", "invalid"] },
    ]),
    ["off", "low", "max"],
  );
  assert.deepEqual(thinkingLevelsFromModelsDev(true, [{ type: "toggle" }]), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(true, [{ type: "budget_tokens" }]), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(true, []), ["low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(false, [{ type: "effort", values: ["high"] }]), []);
});

test("catalog matching prefers vendor aliases and accepts API version suffixes", async () => {
  const calls = [];
  const catalog = new ModelsDevCatalog(async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(catalogFixture), {
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(await catalog.ensureLoaded(), true);
  assert.deepEqual(calls, [MODELS_DEV_API_URL]);

  const byAlias = catalog.modelsForProvider({
    vendorKey: "together",
    baseUrl: "https://unrelated.example/v1",
    providerId: "row-1",
  });
  assert.equal(byAlias.length, 3);
  assert.equal(byAlias[0].providerId, "row-1");

  const byUrl = catalog.findModel({
    vendorKey: "custom",
    baseUrl: "https://api.together.test/v1/",
    modelId: "reasoner-v2",
  });
  assert.equal(byUrl?.displayName, "Reasoner V2");

  const byKnownNativeUrl = catalog.modelsForProvider({
    vendorKey: "custom",
    baseUrl: "https://api.openai.com/v1",
    providerId: "row-2",
  });
  assert.deepEqual(byKnownNativeUrl.map((model) => model.modelId), ["gpt-test"]);

  // Concurrent/duplicate reads reuse the successful snapshot.
  assert.equal(await catalog.ensureLoaded(), true);
  assert.equal(calls.length, 1);
});

test("catalog fetch failures leave the pi-ai fallback path available", async () => {
  const catalog = new ModelsDevCatalog(async () => {
    throw new Error("offline");
  });
  assert.equal(await catalog.ensureLoaded(), false);
  assert.equal(catalog.modelsForProvider({ vendorKey: "together", providerId: "row" }).length, 0);
});
