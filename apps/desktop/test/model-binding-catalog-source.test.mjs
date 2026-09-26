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

/**
 * A catalog read *after* models.dev corrected the model: the published window
 * (1,050,000) differs from the value a binding saved earlier snapshotted.
 */
const CORRECTED_CONTEXT_WINDOW = 1_050_000;

const fixture = {
  requesty: {
    name: "Requesty",
    api: "https://router.requesty.ai/v1",
    models: {
      "terra": {
        id: "terra",
        reasoning: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: CORRECTED_CONTEXT_WINDOW, output: 64_000 },
      },
      "unpublished": {
        id: "unpublished",
        reasoning: false,
        modalities: { input: ["text"], output: ["text"] },
        // No published limit: values.dev has nothing to correct here.
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
  return createProviderCatalogRuntime({
    getHost: () => null,
    modelsDevCatalog: catalog,
  });
}

function providerFor(binding) {
  return {
    id: "provider-row",
    name: "Requesty",
    vendorKey: "requesty",
    baseUrl: "https://router.requesty.ai/v1",
    models: [binding],
  };
}

function enrichedContextWindow(runtime, binding) {
  const provider = runtime.enrichProvider(providerFor(binding));
  return provider.models[0].contextWindow;
}

test("a catalog-sourced binding adopts a models.dev correction", async () => {
  const runtime = await fixtureRuntime();
  // The value the binding snapshotted when the model was added.
  const binding = {
    id: "terra",
    contextWindow: 1_048_576,
    contextWindowSource: "catalog",
    maxTokens: 64_000,
    thinkingLevels: ["off"],
  };
  assert.equal(enrichedContextWindow(runtime, binding), CORRECTED_CONTEXT_WINDOW);
});

test("a user output cap stays pinned independently of its catalog window", async () => {
  const runtime = await fixtureRuntime();
  const edited = {
    id: "terra",
    contextWindow: 1_048_576,
    contextWindowSource: "catalog",
    maxTokens: 8_192,
    maxTokensSource: "user",
    thinkingLevels: ["off"],
  };
  const enriched = runtime.enrichProvider(providerFor(edited)).models[0];
  assert.equal(enriched.contextWindow, CORRECTED_CONTEXT_WINDOW);
  assert.equal(enriched.maxTokens, 8_192);
  assert.equal(enriched.maxTokensSource, "user");

  // Settings receives the independent marker and must not lose it on a save.
  const savedAgain = runtime.enrichProvider(providerFor(enriched)).models[0];
  assert.equal(savedAgain.maxTokens, 8_192);
  assert.equal(savedAgain.maxTokensSource, "user");
});

test("a legacy non-generic output cap stays explicit when the window follows catalog", async () => {
  const runtime = await fixtureRuntime();
  const legacy = {
    id: "terra",
    contextWindow: 1_048_576,
    contextWindowSource: "catalog",
    maxTokens: 4_096,
    thinkingLevels: ["off"],
  };
  const enriched = runtime.enrichProvider(providerFor(legacy)).models[0];
  assert.equal(enriched.maxTokens, 4_096);
  assert.equal(enriched.maxTokensSource, "user");
});

test("a hand-edited window that equals the generic seed is still the user's", async () => {
  const runtime = await fixtureRuntime();
  // 128k is the generic fallback this codebase inherits from the catalog, so a
  // user who picks exactly that number for a smaller endpoint must not be read
  // as "follow models.dev".
  const explicit = {
    id: "terra",
    contextWindow: 128_000,
    contextWindowSource: "user",
    maxTokens: 8_192,
    thinkingLevels: ["off"],
  };
  assert.equal(enrichedContextWindow(runtime, explicit), 128_000);
});

test("unmarked records keep the rule they were written under", async () => {
  const runtime = await fixtureRuntime();
  const legacySeed = {
    id: "terra",
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ["off"],
  };
  const legacyOverride = {
    id: "terra",
    contextWindow: 400_000,
    maxTokens: 8_192,
    thinkingLevels: ["off"],
  };
  // An unmarked stored number may be a user override, so an upgrade preserves it.
  assert.equal(enrichedContextWindow(runtime, legacySeed), 128_000);
  assert.equal(enrichedContextWindow(runtime, legacyOverride), 400_000);
});

test("a catalog value leaves the binding marked as catalog-sourced", async () => {
  const runtime = await fixtureRuntime();
  const legacySeed = {
    id: "terra",
    contextWindow: 128_000,
    contextWindowSource: "catalog",
    maxTokens: 8_192,
    maxTokensSource: "catalog",
    thinkingLevels: ["off"],
  };
  const enriched = runtime.enrichProvider(providerFor(legacySeed)).models[0];
  // Settings round-trip safety: a later save of this row must not turn the
  // inherited value into a frozen snapshot of its own.
  assert.equal(enriched.contextWindowSource, "catalog");
  assert.equal(
    enrichedContextWindow(runtime, { ...enriched, contextWindow: 1_100_000 }),
    CORRECTED_CONTEXT_WINDOW,
  );

  const userEdited = runtime.enrichProvider(
    providerFor({ ...legacySeed, contextWindow: 256_000, contextWindowSource: "user" }),
  ).models[0];
  assert.equal(userEdited.contextWindowSource, "user");
});

test("a model the catalog does not publish keeps its stored window", async () => {
  const runtime = await fixtureRuntime();
  const binding = {
    id: "unpublished",
    contextWindow: 96_000,
    contextWindowSource: "user",
    maxTokens: 8_192,
    thinkingLevels: ["off"],
  };
  assert.equal(enrichedContextWindow(runtime, binding), 96_000);
});
