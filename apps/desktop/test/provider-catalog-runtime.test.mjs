import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import { genericModelConfig } from "@pi-desktop/agent-runtime";
import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

const fixtureDirectory = await mkdtemp(join(tmpdir(), "models-dev-runtime-fixture-"));
const catalogPath = join(fixtureDirectory, "api.json");
await writeFile(catalogPath, JSON.stringify({
  example: {
    name: "Example",
    api: "https://models.example/v1",
    models: {
      "catalog-model": {
        id: "catalog-model",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128_000, output: 8_192 },
      },
      "text-model": {
        id: "text-model",
        reasoning: false,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128_000, output: 8_192 },
      },
    },
  },
}), "utf8");
test.after(() => rm(fixtureDirectory, { recursive: true, force: true }));

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

async function fixtureRuntime() {
  const catalog = new ModelsDevCatalog({ catalogPath });
  await catalog.ensureLoaded();
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
    assert.deepEqual(provider.models[0].thinkingLevels, ["max"], "saved preferences remain intact");
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
  Object.defineProperty(match, "name", {
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
      supportedThinkingLevels: ["low", "high"],
    })));
  }
  assert.ok(modelReads <= 4, "bulk session reads reuse the one effective projection");
});

test("full wire IDs isolate configured bindings while catalog aliases remain metadata-only", async () => {
  const { runtime } = await fixtureRuntime();
  const modelId = "proxy/catalog-model";
  const binding = (id, contextWindow, thinkingLevels) => ({
    id, contextWindow, contextWindowSource: "user", maxTokens: 4_096, thinkingLevels,
  });
  const provider = {
    id: "provider-row", name: "Example", vendorKey: "example",
    baseUrl: "https://models.example/v1",
    models: [
      binding("catalog-model", 16_000, ["off"]),
      binding("PROXY/CATALOG-MODEL ", 32_000, ["high"]),
    ],
  };
  const catalogConfig = genericModelConfig(modelId, provider.baseUrl);
  assert.equal(runtime.bindingForModel(provider, ` ${modelId} `), provider.models[1]);
  assert.equal(runtime.modelsDevModelFor(provider, modelId)?.modelId, "catalog-model");
  const selected = runtime.effectiveSubagentModelConfig(provider, modelId, catalogConfig);
  assert.equal(selected.modelConfig.name, "catalog-model", "the display name follows the published record");
  assert.equal(selected.modelConfig.contextWindow, 32_000);
  assert.deepEqual(selected.capabilities.supportedThinkingLevels, ["high"]);
  const session = { providerId: provider.id, modelId };
  assert.deepEqual(runtime.enrichSession(session, [provider]).supportedThinkingLevels, ["high"]);
  assert.equal(runtime.enrichProvider(provider, modelId).models[1].contextWindow, 32_000);
  assert.equal(runtime.enrichProvider(provider, "catalog-model").contextWindow, 16_000);
  assert.equal(session.modelId, modelId);

  provider.models = [provider.models[0]];
  assert.equal(runtime.bindingForModel(provider, modelId), undefined);
  assert.equal(runtime.effectiveSubagentModelConfig(provider, modelId, catalogConfig).modelConfig.contextWindow, 128_000);
  assert.deepEqual(runtime.enrichSession(session, [provider]).supportedThinkingLevels, ["low", "high"]);
  assert.equal(runtime.effectiveSubagentModelConfig(provider, modelId).modelConfig.contextWindow, 128_000);
  const otherProvider = { ...provider, id: "other-provider", models: [binding(modelId, 48_000, ["off"])] };
  // A different account's exact wire binding must not leak into this row.
  assert.deepEqual(runtime.enrichSession(session, [otherProvider, provider]).supportedThinkingLevels, ["low", "high"]);
});

test("unmatched models expose selectable thinking in providers, sessions and subagents", async () => {
  const { runtime } = await fixtureRuntime();
  const modelId = "ag/gemini-pro-agent";
  const full = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const binding = { id: modelId, contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: [] };
  for (const models of [[], [binding], [{ ...binding, thinkingLevels: ["off"] }]]) {
    const provider = { id: "custom", name: "Custom", models, defaultModelId: modelId };
    const expected = models[0]?.thinkingLevels.length ? ["off"] : full;
    const session = { providerId: provider.id, modelId, thinkingLevel: "off" };
    assert.deepEqual(runtime.enrichProvider(provider).supportedThinkingLevels, expected);
    assert.deepEqual(runtime.enrichSession(session, [provider]).supportedThinkingLevels, expected);
    assert.equal(runtime.enrichSession(session, [provider]).thinkingLevel, "off");
    assert.deepEqual(runtime.effectiveSubagentModelConfig(provider, modelId, genericModelConfig(modelId)).capabilities.supportedThinkingLevels, expected);
  }
});

test("a saved missing or disabled account never inherits another account's capabilities", async () => {
  const { runtime } = await fixtureRuntime();
  const provider = { id: "other", name: "Other", vendorKey: "example", enabled: true };
  const defaults = { defaultProviderId: provider.id, defaultModelId: "catalog-model" };
  for (const providers of [[provider], [provider, { ...provider, id: "saved", enabled: false }]]) {
    const result = runtime.enrichSession({ providerId: "saved", modelId: "catalog-model" }, providers, defaults);
    assert.equal(result.supportsReasoning, false);
    assert.equal(result.supportsVision, false);
  }
  assert.equal(runtime.enrichSession({}, [provider], defaults).supportsVision, true);
});

test("a user-pinned context window is never replaced by the catalog number (#1176)", async () => {
  const { runtime } = await fixtureRuntime();
  // A relay model whose catalog hit publishes 16k while the user pinned 1M.
  const provider = {
    id: "relay",
    name: "Relay",
    vendorKey: "example",
    baseUrl: "https://models.example/v1",
    models: [
      { id: "catalog-model", contextWindow: 1_000_000, maxTokens: 8_192, thinkingLevels: [] },
      { id: "hand-typed-model", contextWindow: 1_000_000, maxTokens: 8_192, thinkingLevels: [] },
    ],
  };
  const enriched = runtime.enrichProvider(provider).models;
  assert.equal(enriched[0].contextWindow, 1_000_000, "a user pin on a catalog hit stays");
  assert.equal(enriched[1].contextWindow, 1_000_000, "a user pin on an unmatched id stays");
  // An inherited row keeps following the catalog.
  const inherited = runtime.enrichProvider({
    ...provider,
    models: [{ id: "catalog-model", contextWindow: 8_000, maxTokens: 8_192, thinkingLevels: [], contextWindowSource: "catalog" }],
  }).models;
  assert.equal(inherited[0].contextWindow, 128_000, "a catalog-sourced window follows the published value");
});
