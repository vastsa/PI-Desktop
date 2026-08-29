import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModelsDevCatalog,
  coerceModelSearchInput,
  parseModelsDevCatalog,
  presetsWithConfiguredProviders,
} from "../electron/main/models-dev-catalog.ts";

const textModalities = { input: ["text"], output: ["text"] };

/**
 * A deliberately small catalog: three providers with different adapters, model
 * counts and capability mixes, so preset derivation, ranking and filtering are
 * all observable without loading the real multi-megabyte snapshot.
 */
const catalogFixture = {
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
        family: "claude-opus",
        attachment: true,
        reasoning: true,
        tool_call: true,
        release_date: "2026-02-05",
        last_updated: "2026-03-13",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1000000, output: 128000 },
      },
      "claude-opus-4.6-mini": {
        id: "claude-opus-4.6-mini",
        name: "Claude 4.6 Opus Mini",
        family: "claude-opus",
        tool_call: true,
        last_updated: "2026-01-09",
        modalities: textModalities,
        limit: { context: 200000, output: 32000 },
      },
      "legacy-claude-opus-4.6-preview": {
        id: "legacy-claude-opus-4.6-preview",
        name: "Legacy Preview",
        last_updated: "2025-06-01",
        modalities: textModalities,
        limit: { context: 100000, output: 8000 },
      },
      "audio-only": {
        id: "audio-only",
        modalities: { input: ["audio"], output: ["audio"] },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    doc: "https://platform.openai.com/docs",
    env: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    models: {
      "gpt-6": {
        id: "gpt-6",
        name: "GPT-6",
        family: "gpt",
        reasoning: true,
        tool_call: true,
        attachment: true,
        last_updated: "2026-04-01",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 400000, output: 64000 },
      },
      "gpt-5-turbo": {
        id: "gpt-5-turbo",
        name: "GPT-5 Turbo",
        family: "omni-line",
        last_updated: "2025-11-20",
        modalities: textModalities,
        limit: { context: 128000, output: 16000 },
      },
    },
  },
};

const fixtureWithGateway = {
  ...catalogFixture,
  "openrouter-lite": {
    id: "openrouter-lite",
    name: "OpenRouter Lite",
    npm: "@ai-sdk/openai-compatible",
    api: "https://openrouter.example/api/v1",
    env: [],
    models: {
      "router/one": {
        id: "router/one",
        name: "Router One",
        modalities: textModalities,
        limit: { context: 32000, output: 4000 },
      },
    },
  },
};

async function loadedCatalog(fixture = fixtureWithGateway) {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-catalog-search-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(fixture), "utf8");
  const catalog = new ModelsDevCatalog({
    catalogPath,
    fetchImpl: async () => {
      throw new Error("catalog search must not touch the network");
    },
  });
  assert.equal(await catalog.ensureLoaded(), true);
  return { catalog, dir };
}

test("parsed providers keep the published npm, env and doc fields", () => {
  const providers = parseModelsDevCatalog(fixtureWithGateway);
  const anthropic = providers.find((item) => item.providerKey === "anthropic");
  assert.equal(anthropic.npm, "@ai-sdk/anthropic");
  assert.equal(anthropic.doc, "https://docs.anthropic.com");
  assert.deepEqual(anthropic.env, ["ANTHROPIC_API_KEY"]);
  assert.equal(anthropic.api, "https://api.anthropic.com");
  const gateway = providers.find((item) => item.providerKey === "openrouter-lite");
  assert.deepEqual(gateway.env, [], "a provider without env vars parses to an empty list");
  assert.equal(gateway.doc, undefined);
});

test("presets derive the wire API style from the published adapter package", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const presets = catalog.presets();
    const styleFor = (key) => presets.find((item) => item.providerKey === key).apiStyle;
    assert.equal(styleFor("anthropic"), "anthropic_messages");
    assert.equal(styleFor("openai"), "responses");
    assert.equal(styleFor("openrouter-lite"), "chat_completions");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("presets expose env vars, docs, base URL and text-capable model counts", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const presets = catalog.presets();
    const anthropic = presets.find((item) => item.providerKey === "anthropic");
    assert.deepEqual(anthropic.envVars, ["ANTHROPIC_API_KEY"]);
    assert.equal(anthropic.doc, "https://docs.anthropic.com");
    assert.equal(anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(anthropic.modelCount, 3, "the audio-only record is not agent-capable");
    assert.equal(anthropic.configuredProviderId, undefined);
    const gateway = presets.find((item) => item.providerKey === "openrouter-lite");
    assert.deepEqual(gateway.envVars, []);
    assert.equal(gateway.doc, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("presets sort by model count so mainstream providers surface first", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    assert.deepEqual(
      catalog.presets().map((item) => item.providerKey),
      ["anthropic", "openai", "openrouter-lite"],
    );
    assert.deepEqual(
      catalog.presets().map((item) => item.modelCount),
      [3, 2, 1],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured rows claim presets by vendor key or by documented endpoint", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const marked = presetsWithConfiguredProviders(catalog.presets(), [
      { id: "row-anthropic", vendorKey: "anthropic" },
      { id: "row-openai", vendorKey: "custom", baseUrl: "https://api.openai.com/" },
    ]);
    const configuredFor = (key) =>
      marked.find((item) => item.providerKey === key).configuredProviderId;
    assert.equal(configuredFor("anthropic"), "row-anthropic");
    assert.equal(configuredFor("openai"), "row-openai", "a trailing /v1 must still match");
    assert.equal(configuredFor("openrouter-lite"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search ranks exact ids above prefixes and prefixes above substrings", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const output = catalog.searchModels({ query: " Claude-Opus-4.6 " });
    assert.equal(output.degraded, false);
    assert.deepEqual(
      output.results.map((item) => item.model.modelId),
      ["claude-opus-4.6", "claude-opus-4.6-mini", "legacy-claude-opus-4.6-preview"],
    );
    assert.deepEqual(
      output.results.map((item) => item.score),
      [100, 80, 60],
    );
    assert.equal(output.results[0].providerKey, "anthropic");
    assert.equal(output.results[0].providerName, "Anthropic");
    assert.equal(output.results[0].model.providerId, "anthropic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("weaker hits score by display name, family and provider name", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const byDisplayName = catalog.searchModels({ query: "Opus Mini" });
    assert.deepEqual(
      byDisplayName.results.map((item) => [item.model.modelId, item.score]),
      [["claude-opus-4.6-mini", 40]],
      "a display-name-only hit scores below any id hit",
    );
    const byFamily = catalog.searchModels({ query: "omni" });
    assert.deepEqual(
      byFamily.results.map((item) => [item.model.modelId, item.score]),
      [["gpt-5-turbo", 20]],
      "a family-only hit scores below a display-name hit",
    );
    const byProviderName = catalog.searchModels({ query: "openrouter" });
    assert.deepEqual(
      byProviderName.results.map((item) => [item.model.modelId, item.score]),
      [["router/one", 10]],
      "a provider-name-only hit is the weakest match",
    );
    const byId = catalog.searchModels({ query: "claude-opus" });
    assert.deepEqual(
      byId.results.map((item) => item.score),
      [80, 80, 60],
      "id hits outrank every metadata hit",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capability filters exclude models that do not publish the capability", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    assert.deepEqual(
      catalog.searchModels({ filters: ["reasoning"] }).results.map((item) => item.model.modelId),
      ["gpt-6", "claude-opus-4.6"],
    );
    assert.deepEqual(
      catalog
        .searchModels({ filters: ["vision", "tools", "attachments"] })
        .results.map((item) => item.model.modelId),
      ["gpt-6", "claude-opus-4.6"],
    );
    assert.deepEqual(
      catalog
        .searchModels({ query: "claude", filters: ["vision"] })
        .results.map((item) => item.model.modelId),
      ["claude-opus-4.6"],
    );
    assert.equal(catalog.searchModels({ query: "router", filters: ["tools"] }).total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty query lists current models first instead of alphabetical noise", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const output = catalog.searchModels({});
    assert.equal(output.total, 6);
    assert.deepEqual(
      output.results.map((item) => item.model.modelId),
      [
        "gpt-6",
        "claude-opus-4.6",
        "claude-opus-4.6-mini",
        "gpt-5-turbo",
        "legacy-claude-opus-4.6-preview",
        "router/one",
      ],
    );
    assert.deepEqual([...new Set(output.results.map((item) => item.score))], [0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search can restrict to a single models.dev provider key", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const output = catalog.searchModels({ providerKey: "OpenAI" });
    assert.equal(output.total, 2);
    assert.deepEqual(
      output.results.map((item) => item.model.modelId),
      ["gpt-6", "gpt-5-turbo"],
    );
    assert.equal(
      catalog.searchModels({ providerKey: "does-not-exist" }).total,
      0,
      "an unknown provider key returns nothing rather than everything",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("limits are clamped while total still counts every match", async () => {
  const { catalog, dir } = await loadedCatalog();
  try {
    const limited = catalog.searchModels({ limit: 2 });
    assert.equal(limited.results.length, 2);
    assert.equal(limited.total, 6, "total reports matches before the limit");
    assert.equal(catalog.searchModels({ limit: 0 }).results.length, 1, "limit clamps up to 1");
    assert.equal(catalog.searchModels({ limit: -5 }).results.length, 1);
    assert.equal(catalog.searchModels({ limit: 10000 }).results.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untrusted search payloads are coerced and unknown filters dropped", () => {
  assert.deepEqual(
    coerceModelSearchInput({
      query: "  gpt  ",
      providerKey: " openai ",
      providerId: "row-1",
      filters: ["vision", "wat", 3, "tools"],
      limit: 900,
    }),
    {
      query: "gpt",
      providerKey: "openai",
      providerId: "row-1",
      filters: ["vision", "tools"],
      limit: 500,
    },
  );
  assert.deepEqual(coerceModelSearchInput(undefined), { limit: 200 });
  assert.deepEqual(coerceModelSearchInput({ limit: "many", query: "  " }), { limit: 200 });
  assert.deepEqual(coerceModelSearchInput({ limit: 0.5 }), { limit: 1 });
});

test("search degrades to an empty result when no snapshot could be loaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-catalog-degraded-"));
  try {
    const catalog = new ModelsDevCatalog({
      catalogPath: join(dir, "missing.json"),
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(await catalog.ensureLoaded(), false);
    assert.deepEqual(catalog.searchModels({ query: "gpt" }), {
      results: [],
      total: 0,
      degraded: true,
    });
    assert.deepEqual(catalog.presets(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
