import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apiStyleForAdapter, modelIdsMatch } from "@pi-desktop/shared";

import {
  MODELS_DEV_API_URL,
  ModelsDevCatalog,
  modelConfigFromModelsDev,
  modelInfoFromModelsDev,
  parseModelsDevCatalog,
  thinkingLevelsFromModelsDev,
} from "../electron/main/models-dev-catalog.ts";

const catalogFixture = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-4.6": {
        id: "claude-opus-4.6",
        name: "Claude 4.6 Opus",
        description: "High-end Claude for difficult coding, planning, and slower expert reasoning",
        family: "claude-opus",
        attachment: true,
        reasoning: true,
        reasoning_options: [{
          type: "effort",
          values: ["low", "medium", "high", "xhigh", "max"],
        }],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: "2025-05-31",
        release_date: "2026-02-05",
        last_updated: "2026-03-13",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        open_weights: false,
        limit: {
          context: 1_000_000,
          input: 1_000_000,
          output: 128_000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
          reasoning: 25,
          input_audio: 7,
          output_audio: 28,
          tiers: [{
            input: 10,
            output: 37.5,
            cache_read: 1,
            tier: { type: "context", size: 200_000 },
          }],
          context_over_200k: {
            input: 10,
            output: 37.5,
            cache_read: 1,
            cache_write: 12.5,
          },
        },
        interleaved: { field: "reasoning_content" },
        status: "stable",
        experimental: { modes: { fast: { enabled: true } } },
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "audio-only": {
        id: "audio-only",
        modalities: { input: ["audio"], output: ["text"] },
      },
      "metadata-sparse": { id: "metadata-sparse" },
    },
  },
};

function responseFor(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("model IDs match provider namespaces without matching model variants", () => {
  assert.equal(modelIdsMatch("anthropic-claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("anthropic/claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("claude-opus-5@default", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("claude-opus-5-fast", "claude-opus-5"), false);
});

test("models.dev records retain all published model parameters and modalities", () => {
  const [provider] = parseModelsDevCatalog(catalogFixture);
  assert.equal(provider.providerKey, "anthropic");
  assert.equal(provider.models.length, 3, "raw parsing keeps non-text records too");

  const model = provider.models.find((item) => item.modelId === "claude-opus-4.6");
  assert.equal(model.providerApi, undefined);
  assert.equal(model.displayName, "Claude 4.6 Opus");
  assert.equal(model.description, "High-end Claude for difficult coding, planning, and slower expert reasoning");
  assert.equal(model.family, "claude-opus");
  assert.equal(model.attachment, true);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.reasoningOptions, [{
    type: "effort",
    values: ["low", "medium", "high", "xhigh", "max"],
  }]);
  assert.deepEqual(model.modalities, {
    input: ["text", "image", "pdf"],
    output: ["text"],
  });
  assert.deepEqual(model.limit, {
    context: 1_000_000,
    input: 1_000_000,
    output: 128_000,
  });
  assert.deepEqual(model.cost, {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    reasoning: 25,
    inputAudio: 7,
    outputAudio: 28,
    tiers: [{
      input: 10,
      output: 37.5,
      cacheRead: 1,
      tier: { type: "context", size: 200_000 },
    }],
    contextOver200k: {
      input: 10,
      output: 37.5,
      cacheRead: 1,
      cacheWrite: 12.5,
    },
  });
  assert.deepEqual(model.interleaved, { field: "reasoning_content" });
  assert.equal(model.status, "stable");
  assert.equal(model.temperature, false);
  assert.deepEqual(model.experimental, { modes: { fast: { enabled: true } } });
  assert.deepEqual(model.provider, { npm: "@ai-sdk/anthropic" });

  const info = modelInfoFromModelsDev(model, "provider-row");
  assert.equal(info.providerId, "provider-row");
  assert.equal(info.contextWindow, 1_000_000);
  assert.equal(info.maxTokens, 128_000);
  assert.ok(info.capabilities.includes("text"));
  assert.ok(info.capabilities.includes("tools"));
  assert.ok(info.capabilities.includes("vision"));
  assert.ok(info.capabilities.includes("pdf"));
  assert.ok(info.capabilities.includes("reasoning"));
  assert.ok(info.capabilities.includes("json"));
  assert.ok(info.capabilities.includes("attachments"));
  assert.equal(info.capabilities.includes("temperature"), false);
  assert.equal(info.catalogSource, "models.dev");
  assert.deepEqual(info.thinkingLevelMap, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.deepEqual(info.provider, { npm: "@ai-sdk/anthropic" });
  assert.deepEqual(info.experimental, { modes: { fast: { enabled: true } } });
  assert.ok(
    modelInfoFromModelsDev({ ...model, temperature: true }, "provider-row").capabilities.includes(
      "temperature",
    ),
  );
  const allModalities = {
    input: ["text", "image", "audio", "video", "pdf"],
    output: ["text", "image", "audio", "video", "pdf"],
  };
  const multimodalInfo = modelInfoFromModelsDev(
    { ...model, modalities: allModalities },
    "provider-row",
  );
  assert.deepEqual(multimodalInfo.modalities, allModalities);
  for (const capability of ["vision", "audio", "video", "pdf"]) {
    assert.ok(multimodalInfo.capabilities.includes(capability), capability);
  }

  const config = modelConfigFromModelsDev(model, "https://api.anthropic.com");
  assert.equal(config.source, "models.dev");
  assert.equal(config.name, "Claude 4.6 Opus");
  assert.equal(config.contextWindow, 1_000_000);
  assert.equal(config.maxTokens, 128_000);
  assert.deepEqual(config.input, ["text", "image"]);
  assert.deepEqual(config.modalities, info.modalities);
  assert.deepEqual(config.supportedThinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(config.thinkingLevelMap, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal(config.cost.reasoning, 25);
  assert.deepEqual(config.provider, { npm: "@ai-sdk/anthropic" });
  assert.deepEqual(config.catalogProvider, { npm: "@ai-sdk/anthropic" });
  assert.deepEqual(config.experimental, { modes: { fast: { enabled: true } } });
  assert.equal(config.cost.inputAudio, 7);
  assert.equal(config.cost.outputAudio, 28);
  assert.equal(config.cost.tiers?.[0]?.tier?.size, 200_000);
  assert.equal(config.interleaved?.field, "reasoning_content");

  const sparse = provider.models.find((item) => item.modelId === "metadata-sparse");
  assert.equal(sparse.reasoningPublished, false);
  assert.equal(sparse.modalitiesPublished, false);
});

test("models.dev parsing retains every model in a provider", () => {
  const models = Object.fromEntries(
    Array.from({ length: 627 }, (_, index) => [
      `model-${String(index).padStart(4, "0")}`,
      { id: `model-${String(index).padStart(4, "0")}` },
    ]),
  );
  const [provider] = parseModelsDevCatalog({
    provider: { name: "Provider", models },
  });
  assert.equal(provider.models.length, 627);
  assert.equal(provider.models.at(-1)?.modelId, "model-0626");
});

test("matches vendor-prefixed models when the catalog provider key is a gateway", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-provider-match-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      gateway: {
        name: "Gateway",
        api: "https://gateway.example/v1",
        models: {
          "deepseek/deepseek-v4": {
            id: "deepseek/deepseek-v4",
            name: "DeepSeek V4",
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);
    const match = catalog.findModel({
      vendorKey: "deepseek",
      modelId: "deepseek-v4",
    });
    assert.equal(match?.modelId, "deepseek/deepseek-v4");
    assert.deepEqual(match?.modalities.input, ["text", "image", "pdf"]);
    assert.equal(
      catalog.modelsForProvider({ vendorKey: "deepseek", providerId: "row" }).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps the OpenAI Codex account to OpenAI models.dev metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-openai-codex-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      openai: {
        name: "OpenAI",
        models: {
          "gpt-5.6-sol": {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            reasoning: true,
            reasoning_options: [{
              type: "effort",
              values: ["none", "low", "medium", "high", "xhigh", "max"],
            }],
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_050_000, output: 128_000 },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);

    const input = {
      vendorKey: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.6-sol",
    };
    const match = catalog.findModel(input);
    assert.equal(match?.providerKey, "openai");
    assert.equal(match?.reasoning, true);
    assert.deepEqual(match?.thinkingLevels, [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.equal(match?.limit.context, 1_050_000);
    assert.equal(match?.limit.output, 128_000);
    assert.equal(catalog.providerKeyForRow(input), "openai");

    const fallback = catalog.modelsForProvider({
      vendorKey: input.vendorKey,
      baseUrl: input.baseUrl,
      providerId: "oauth-row",
    });
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].modelId, "gpt-5.6-sol");
    assert.deepEqual(fallback[0].supportedThinkingLevels, [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("models.dev reasoning options map to canonical levels", () => {
  assert.deepEqual(
    thinkingLevelsFromModelsDev(true, [{
      type: "effort",
      values: ["max", "low", "none", "invalid"],
    }]),
    ["off", "low", "max"],
  );
  assert.deepEqual(thinkingLevelsFromModelsDev(true, [{ type: "toggle" }]), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(true, [{ type: "budget_tokens", min: 1024 }]), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(true, []), ["low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsFromModelsDev(false, [{ type: "effort", values: ["high"] }]), []);
});

test("the application loads the bundled release snapshot without network access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-release-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  let calls = 0;
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("startup must not fetch");
      },
    });
    assert.equal(await catalog.ensureLoaded(), true);
    assert.equal(calls, 0);
    assert.equal(catalog.getStatus().source, "bundled");
    assert.equal(catalog.getStatus().catalogPath, catalogPath);
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" })?.family,
      "claude-opus",
    );
    assert.equal(
      catalog.modelsForProvider({ vendorKey: "anthropic", providerId: "row" }).length,
      2,
      "only text-capable models enter the agent picker",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent catalog reads share the bundled snapshot load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-concurrent-load-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    const first = catalog.ensureLoaded();
    const second = catalog.ensureLoaded();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" })?.family,
      "claude-opus",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Settings refresh always refetches models.dev and only updates memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-refresh-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  const refreshedFixture = {
    ...catalogFixture,
    anthropic: {
      ...catalogFixture.anthropic,
      models: {
        ...catalogFixture.anthropic.models,
        "new-model": {
          id: "new-model",
          name: "New Model",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 64_000, output: 4_000 },
        },
      },
    },
  };
  const calls = [];
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responseFor(refreshedFixture);
      },
    });
    assert.equal(await catalog.ensureLoaded(), true);
    assert.equal(calls.length, 0);
    assert.equal(await catalog.refresh(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, MODELS_DEV_API_URL);
    assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "new-model" })?.displayName,
      "New Model",
    );
    assert.deepEqual(
      JSON.parse(await readFile(catalogPath, "utf8")),
      catalogFixture,
      "settings refresh must not write the bundled release resource",
    );
    assert.equal(await catalog.refresh(), true, "a second settings refresh is also remote");
    assert.equal(calls.length, 2);
    assert.equal(catalog.getStatus().source, "remote");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed settings refresh preserves the bundled snapshot in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-failure-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(catalogFixture), "utf8");
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(await catalog.ensureLoaded(), true);
    assert.equal(await catalog.refresh(), false);
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" })?.family,
      "claude-opus",
    );
    assert.match(catalog.getStatus().lastError, /offline/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/*
  The published `npm` / `env` / `doc` fields survive parsing because the setup
  form still derives the wire API from the adapter package and still points the
  user at the provider's own docs. Migrated here when the catalog-search suite
  was removed with the browsable-catalog UI.
*/
test("parsed providers keep the published npm, env and doc fields", () => {
  const providers = parseModelsDevCatalog({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com",
      doc: "https://docs.anthropic.com",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-opus-4.6": {
          id: "claude-opus-4.6",
          name: "Claude 4.6 Opus",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200000, output: 64000 },
        },
      },
    },
    "openrouter-lite": {
      id: "openrouter-lite",
      name: "OpenRouter Lite",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "some-model": {
          id: "some-model",
          name: "Some Model",
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  });
  const anthropic = providers.find((item) => item.providerKey === "anthropic");
  assert.equal(anthropic.npm, "@ai-sdk/anthropic");
  assert.equal(anthropic.doc, "https://docs.anthropic.com");
  assert.deepEqual(anthropic.env, ["ANTHROPIC_API_KEY"]);
  assert.equal(anthropic.api, "https://api.anthropic.com");
  const gateway = providers.find((item) => item.providerKey === "openrouter-lite");
  assert.deepEqual(gateway.env, [], "a provider without env vars parses to an empty list");
  assert.equal(gateway.doc, undefined);
});

test("the wire API style is derived from the published adapter package", () => {
  assert.equal(apiStyleForAdapter("@ai-sdk/anthropic"), "anthropic_messages");
  assert.equal(apiStyleForAdapter("@ai-sdk/google-vertex/anthropic"), "anthropic_messages");
  assert.equal(apiStyleForAdapter("@ai-sdk/google"), "google_generative_ai");
  assert.equal(apiStyleForAdapter("@ai-sdk/openai"), "responses");
  // The long tail of gateways is OpenAI-compatible chat completions.
  assert.equal(apiStyleForAdapter("@ai-sdk/openai-compatible"), "chat_completions");
  assert.equal(apiStyleForAdapter(undefined), "chat_completions");
});
