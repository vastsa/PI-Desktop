import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

const runtimeModule = new URL("../electron/main/runtime/provider-catalog.ts", import.meta.url);
// The production bundler resolves this extensionless TypeScript import.
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === runtimeModule.href && specifier === "../models-dev-catalog") {
      return nextResolve("../models-dev-catalog.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { createProviderCatalogRuntime } = await import(runtimeModule.href)
  .finally(() => resolution.deregister());

const fixture = {
  example: {
    name: "Example",
    api: "https://models.example/v1",
    models: {
      "catalog-model": {
        id: "catalog-model",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128_000, output: 8_192 },
      },
      "text-model": {
        id: "text-model",
        reasoning: false,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

async function fixtureRuntime() {
  const catalog = new ModelsDevCatalog({
    catalogPath: "unused-model-catalog.json",
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(await catalog.refresh(), true);
  const runtime = createProviderCatalogRuntime({
    getHost: () => null,
    modelsDevCatalog: catalog,
  });
  return { catalog, runtime };
}

for (const modelId of ["catalog-model", "unpublished-model"]) {
  test(`cached metadata keeps provider binding changes immediate for ${modelId}`, async () => {
    const { catalog, runtime } = await fixtureRuntime();
    const provider = {
      id: "provider-row",
      name: "Example",
      vendorKey: "example",
      baseUrl: "https://models.example/v1",
      models: [{
        id: modelId,
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingLevels: ["low", "high"],
        supportsImages: true,
      }],
    };
    const session = { id: "session-one", providerId: provider.id, modelId };
    const input = { vendorKey: provider.vendorKey, baseUrl: provider.baseUrl, modelId };
    const published = catalog.findModel(input);
    const initial = runtime.enrichSession(session, [provider]);
    assert.equal(initial.supportsReasoning, true);
    assert.equal(initial.supportsVision, true);
    assert.deepEqual(initial.supportedThinkingLevels, ["low", "high"]);

    provider.models = [{
      ...provider.models[0],
      contextWindow: 64_000,
      maxTokens: 4_096,
      thinkingLevels: ["off"],
      supportsImages: false,
    }];
    const updated = runtime.enrichSession(session, [provider]);
    assert.equal(updated.supportsReasoning, false);
    assert.equal(updated.supportsVision, false);
    assert.deepEqual(updated.supportedThinkingLevels, ["off"]);
    assert.equal(runtime.enrichProvider(provider).supportsVision, false);

    provider.models = [{ ...provider.models[0], thinkingLevels: ["max"], supportsImages: true }];
    const restored = runtime.enrichSession(session, [provider]);
    assert.equal(restored.supportsReasoning, true);
    assert.equal(restored.supportsVision, true);
    assert.deepEqual(restored.supportedThinkingLevels, ["max"]);
    assert.equal(catalog.findModel(input), published, "binding edits do not replace catalog metadata");
    assert.deepEqual(session, { id: "session-one", providerId: provider.id, modelId });
  });
}

test("cached session capabilities follow the current default model", async () => {
  const { runtime } = await fixtureRuntime();
  const provider = {
    id: "provider-row",
    name: "Example",
    vendorKey: "example",
    baseUrl: "https://models.example/v1",
  };
  const defaults = { defaultProviderId: provider.id, defaultModelId: "catalog-model" };
  const first = runtime.enrichSession({}, [provider], defaults);
  assert.equal(first.supportsReasoning, true);
  assert.equal(first.supportsVision, true);

  defaults.defaultModelId = "text-model";
  const second = runtime.enrichSession({}, [provider], defaults);
  assert.equal(second.supportsReasoning, false);
  assert.equal(second.supportsVision, false);
  defaults.defaultModelId = "catalog-model";
  assert.deepEqual(runtime.enrichSession({}, [provider], defaults), first);
});

test("a bulk session refresh reuses catalog matches while preserving each session", async () => {
  const { catalog, runtime } = await fixtureRuntime();
  const provider = { id: "provider-row", name: "Example", vendorKey: "example" };
  const input = { vendorKey: provider.vendorKey, modelId: "catalog-model" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const modelId = match.modelId;
  let modelReads = 0;
  Object.defineProperty(match, "modelId", {
    configurable: true,
    get() {
      modelReads += 1;
      return modelId;
    },
  });
  const sessions = Array.from({ length: 816 }, (_, index) => ({
    id: `session-${index}`,
    title: `Task ${index}`,
    providerId: provider.id,
    modelId,
  }));

  for (let refresh = 0; refresh < 2; refresh += 1) {
    const result = sessions.map((session) => runtime.enrichSession(session, [provider]));
    assert.deepEqual(result, sessions.map((session) => ({
      ...session,
      supportsReasoning: true,
      supportsVision: true,
      supportedThinkingLevels: ["low", "medium", "high"],
    })));
  }
  assert.equal(modelReads, 0, "session list refreshes must not repeat catalog matching work");
});
