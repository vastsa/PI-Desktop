import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apiStyleForAdapter, catalogModelIdsMatch, modelIdsMatch } from "@pi-desktop/shared";

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

async function loadFixtureCatalog(t, fixture = catalogFixture) {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "api.json");
  await writeFile(catalogPath, JSON.stringify(fixture), "utf8");
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

function observeModelIdReads(model) {
  const modelId = model.modelId;
  let reads = 0;
  Object.defineProperty(model, "modelId", {
    configurable: true,
    get() {
      reads += 1;
      return modelId;
    },
  });
  return () => reads;
}

test("repeated model matches and misses resolve through the bounded catalog index", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const reads = observeModelIdReads(match);
  const perQuery = reads();

  assert.equal(catalog.findModel({ ...input }), match);
  assert.equal(catalog.findModel({ ...input, modelId: " CLAUDE-OPUS-4.6 " }), match);
  // A repeated exact match returns the same catalog object and touches only the
  // constant-sized candidate bucket, not a full catalog scan.
  assert.ok(reads() - perQuery <= 8, "a repeated match must reuse the catalog result");

  const missing = { ...input, modelId: "unpublished-model" };
  assert.equal(catalog.findModel(missing), undefined);
  const afterMiss = reads();
  assert.equal(catalog.findModel({ ...missing }), undefined);
  assert.equal(catalog.findModel({ ...missing, modelId: " UNPUBLISHED-MODEL " }), undefined);
  // A miss resolves through an empty bucket without scanning or growing the index.
  assert.equal(reads(), afterMiss, "a repeated miss must not search again");
});

test("cached matches remain scoped to the requested provider and endpoint", async (t) => {
  const fixture = Object.fromEntries(["alpha", "beta"].map((key) => [key, {
    name: key,
    api: `https://${key}.example/v1`,
    models: {
      "shared-model": {
        id: "shared-model",
        name: `${key} model`,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  }]));
  const catalog = await loadFixtureCatalog(t, fixture);
  const queries = [
    [{ vendorKey: "alpha", modelId: "shared-model" }, "alpha"],
    [{ vendorKey: "beta", modelId: "shared-model" }, "beta"],
    [{ vendorKey: "custom", baseUrl: "https://alpha.example/v1", modelId: "shared-model" }, "alpha"],
    [{ vendorKey: "custom", baseUrl: "https://beta.example/v1", modelId: "shared-model" }, "beta"],
    [{ vendorKey: "alpha", baseUrl: "https://beta.example/v1", modelId: "shared-model" }, "beta"],
  ];
  for (const [input, providerKey] of [...queries, ...queries.toReversed()]) {
    assert.equal(catalog.findModel(input)?.providerKey, providerKey);
  }
});

test("unknown endpoints do not inherit ambiguous cross-provider metadata", async (t) => {
  for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
    const fixture = Object.fromEntries(order.map((key) => [key, {
      api: `https://${key}.example/v1`,
      models: {
        "shared-model": {
          id: "shared-model",
          reasoning: key === "alpha",
          limit: { context: key === "alpha" ? 128_000 : 32_000, output: 8_192 },
        },
      },
    }]));
    const catalog = await loadFixtureCatalog(t, fixture);
    for (const modelId of ["shared-model", "proxy/shared-model"]) {
      const unknown = { vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId };
      assert.equal(catalog.findModel(unknown), undefined, `ambiguous ${modelId} must miss`);
      assert.equal(catalog.findModel(unknown), undefined, "ambiguous misses are cached");
    }
    const alpha = catalog.findModel({
      vendorKey: "custom", baseUrl: "https://alpha.example/v1", modelId: "shared-model",
    });
    assert.equal(alpha?.providerKey, "alpha", "an exact endpoint scopes the lookup");
    assert.equal(alpha?.reasoning, true);
    assert.equal(alpha?.limit.context, 128_000);
    const beta = catalog.findModel({ vendorKey: "beta", modelId: "shared-model" });
    assert.equal(beta?.providerKey, "beta", "a known provider key scopes the lookup");
    assert.equal(beta?.reasoning, false);
    assert.equal(beta?.limit.context, 32_000);
  }
});

test("an unknown endpoint can use a unique supported proxy alias", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { models: { "shared-model": { id: "shared-model", reasoning: true } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "custom", baseUrl: "https://relay.example/v1", modelId: "proxy/shared-model-thinking",
  })?.providerKey, "alpha");
});

test("a known endpoint cannot borrow another provider's catalog model", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://alpha.example/v1", models: { "alpha-only": { id: "alpha-only" } } },
    beta: { api: "https://beta.example/v1", models: { "proxy/shared-model": { id: "proxy/shared-model", reasoning: true } } },
  });
  assert.equal(catalog.findModel({ baseUrl: "https://alpha.example/v1", modelId: "shared-model" }), undefined);
  assert.equal(catalog.findModel({ baseUrl: "https://beta.example/v1", modelId: "shared-model" })?.providerKey, "beta");
});

test("a shared catalog API prefers the explicitly selected vendor", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://gateway.example/v1", models: { "alpha-only": { id: "alpha-only" } } },
    beta: { api: "https://gateway.example/v1", models: { "beta-only": { id: "beta-only" } } },
  });
  const input = { vendorKey: "beta", baseUrl: "https://gateway.example/v1" };
  assert.equal(catalog.findModel({ ...input, modelId: "beta-only" })?.providerKey, "beta");
  assert.equal(catalog.findModel({ ...input, modelId: "alpha-only" }), undefined);
});

test("a shared catalog API with no vendor key cannot select the first publisher", async (t) => {
  for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
    const catalog = await loadFixtureCatalog(t, Object.fromEntries(order.map((key) => [key, {
      api: "https://gateway.example/v1",
      models: { "shared-model": { id: "shared-model", reasoning: key === "alpha",
        limit: { context: key === "alpha" ? 128_000 : 32_000, output: 8_192 } } },
    }])));
    assert.equal(catalog.providerKeyForRow({ vendorKey: "custom", baseUrl: "https://gateway.example/v1" }), undefined);
    assert.equal(catalog.findModel({ vendorKey: "custom", baseUrl: "https://gateway.example/v1", modelId: "shared-model" }), undefined);
    assert.equal(catalog.findModel({ vendorKey: "beta", baseUrl: "https://gateway.example/v1", modelId: "shared-model" })?.providerKey, "beta");
  }
});

test("a recognized endpoint takes priority over an unrelated vendor fallback", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    openai: { models: { "shared-model": { id: "shared-model" } } },
    deepseek: { models: { "shared-model": { id: "shared-model" } } },
  });
  assert.equal(catalog.findModel({
    vendorKey: "openai",
    baseUrl: "https://api.deepseek.com",
    modelId: "shared-model",
  })?.providerKey, "deepseek");
});

test("model lookup memory is bounded by the catalog, not by query count", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const reads = observeModelIdReads(match);

  // Thousands of distinct miss queries do not grow the per-generation index and
  // do not evict an already-resolved key from it.
  for (let index = 0; index < 3_000; index += 1) {
    assert.equal(catalog.findModel({ ...input, modelId: `unknown-${index}` }), undefined);
  }
  const beforeRepeat = reads();
  assert.equal(catalog.findModel(input), match);
  // The resolved key stays resolvable to the same object without a catalog rescan.
  assert.ok(reads() - beforeRepeat <= 8, "a resolved key stays usable after many distinct queries");
});

test("one read with more distinct keys than any cache budget does not rescan a resolved key", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const reads = observeModelIdReads(match);
  const baseline = reads();
  const exactRepeats = 2_000;
  // Interleave the originally resolved key among a burst of distinct keys far
  // larger than the former 1,024-entry per-key eviction cache.
  for (let index = 0; index < exactRepeats; index += 1) {
    catalog.findModel({ ...input, modelId: `unknown-${index}` });
    catalog.findModel(input);
  }
  const touches = reads() - baseline;
  // Each exact re-query resolves through a bounded candidate bucket, so the work
  // stays proportional to the repeated queries and independent of the distinct
  // keys interleaved between them. The old 1,024-entry eviction cache would rescan
  // the whole catalog (thousands of model reads) on every repeat once its budget
  // was exceeded, growing with the distinct-key burst.
  assert.ok(
    touches <= exactRepeats * 8,
    `exact re-queries touched the model ${touches} times, expected <= ${exactRepeats * 8}`,
  );
});

test("model IDs match provider namespaces without matching model variants", () => {
  assert.equal(modelIdsMatch("anthropic-claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("anthropic/claude-opus-5", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("claude-opus-5@default", "claude-opus-5"), true);
  assert.equal(modelIdsMatch("claude-opus-5-fast", "claude-opus-5"), false);
  for (const suffix of ["agent", "latest", "thinking", "think"]) {
    assert.equal(modelIdsMatch("foo", `foo-${suffix}`), false);
    assert.equal(modelIdsMatch(`foo-${suffix}`, "foo"), false);
  }
  assert.equal(modelIdsMatch("gateway-a/foo", "gateway-b/foo"), false);
  assert.equal(modelIdsMatch("foo@us-east", "foo@eu-west"), false);
  assert.equal(modelIdsMatch("proxy/openai/gpt-4o", "openai/gpt-4o"), true);
  assert.equal(modelIdsMatch("openai/gpt-4o", "proxy/gpt-4o"), false);
});
test("catalog metadata IDs match exact proxy paths and supported variants", () => {
  for (const [catalogId, request] of [
    ["claude-opus-4.6", "proxy/claude-opus-4.6"],
    ["claude-opus-4.6", "custom/claude-opus-4.6"],
    ["claude-opus-4.6", "relay/claude-opus-4.6"],
    ["claude-opus-4.6", "gateway-01/claude-opus-4.6"],
    ["openai/gpt-4o", "hub/openai/gpt-4o"],
    ["claude-opus-4.6", "proxy/claude-opus-4.6-thinking"],
    ["claude-opus-4.6", "claude-opus-4.6:thinking"],
    ["claude-opus-4.6", "proxy/claude-opus-4.6-agent"],
    ["claude-opus-4.6", "proxy/claude-opus-4.6-latest"],
    ["claude-opus-4.6", "proxy/claude-opus-4.6-agent-thinking"],
    ["proxy/nested/claude-opus-4.6@us-east", "claude-opus-4.6-thinking"],
    ["anthropic-claude-opus-4.6", "claude-opus-4.6@us-east"],
    ["google/gemini-pro-latest", "gemini-pro"],
  ]) {
    assert.equal(catalogModelIdsMatch(catalogId, request), true, `${catalogId} / ${request}`);
    assert.equal(catalogModelIdsMatch(request, catalogId), true, `${request} / ${catalogId}`);
  }

  for (const [catalogId, request] of [
    ["google/gemini-2.5-flash", "openai/gemini-2.5-flash"],
    ["claude-opus-4.6", "myproxy-claude-opus-4.6"],
    ["claude-opus-4.6", "myproxy-claude-opus-4.6-thinking"],
    ["google/gemini-2.5-flash", "gemini-2.5-flash-high"],
    ["google/gemini-2.5-flash", "gemini-2.5-flash-low"],
    ["google/gemini-2.5-flash", "gemini-2.5-flash:minimal"],
    ["claude-opus-5", "claude-opus-5-fast"],
    ["gpt-4o", "gpt-4o-mini"],
    ["gpt-4", "gpt-4o"],
    ["model", "other-model"],
    ["custom", "gemini-3.1-pro-preview-customtools"],
    ["groq/whisper-large-v3", "deepseek-v3"],
    ["vercel/bfl/flux-kontext-max", "qwen-max"],
    ["alibaba/qwen3-asr-flash", "qwen-flash"],
    ["openai/gpt-4o", "proxy/gpt-4o"],
    ["google/gemini-2.5-flash", "proxy/gemini-2.5-flash"],
    ["proxy/nested/claude-opus-4.6", "other/claude-opus-4.6"],
    ["claude-opus-4-6-max", "qwen-max"],
  ]) {
    assert.equal(catalogModelIdsMatch(catalogId, request), false, `${catalogId} / ${request}`);
    assert.equal(catalogModelIdsMatch(request, catalogId), false, `${request} / ${catalogId}`);
  }
  assert.equal(catalogModelIdsMatch("gateway-a/foo", "gateway-b/foo"), false);
  assert.equal(catalogModelIdsMatch("foo", "foo-think"), true);
  assert.equal(catalogModelIdsMatch("foo", "foo-agent"), true);
  assert.equal(catalogModelIdsMatch("foo", "foo-latest"), true);
});

test("catalog lookup indexes exact path leaves and known vendor variants without broad aliases", async (t) => {
  const ids = [
    "model", "custom", "groq/whisper-large-v3", "vercel/bfl/flux-kontext-max",
    "alibaba/qwen3-asr-flash", "proxy/nested/claude-opus-4.6@us-east",
    "anthropic-claude-sonnet-4", "openai.gpt-4o", "google/gemini-2.5-flash",
  ];
  const catalog = await loadFixtureCatalog(t, {
    gateway: { models: Object.fromEntries(ids.map((id) => [id, { id }])) },
  });
  for (const [request, expected] of [
    ["other-model", undefined],
    ["gemini-3.1-pro-preview-customtools", undefined],
    ["deepseek-v3", undefined],
    ["qwen-max", undefined],
    ["qwen-flash", undefined],
    ["myproxy-claude-opus-4.6", undefined],
    ["gemini-2.5-flash-high", undefined],
    ["gemini-2.5-flash-low", undefined],
    ["claude-opus-4.6-thinking", "proxy/nested/claude-opus-4.6@us-east"],
    ["proxy/claude-opus-4.6-thinking", undefined],
    ["claude-sonnet-4-agent", "anthropic-claude-sonnet-4"],
    ["proxy/gemini-2.5-flash", undefined],
    ["gpt-4o@eu", "openai.gpt-4o"],
  ]) {
    assert.equal(catalog.findModel({ vendorKey: "custom", modelId: request })?.modelId, expected, request);
  }
  assert.equal(catalog.findModel({ vendorKey: "custom", modelId: "openai/gemini-2.5-flash" }), undefined);
});

test("matches supported proxy path and reasoning variants in catalog lookup", async (t) => {
  const catalog = await loadFixtureCatalog(t);
  for (const modelId of [
    "proxy/claude-opus-4.6", "proxy/claude-opus-4.6-thinking",
    "proxy/claude-opus-4.6-agent", "claude-opus-4.6:thinking",
    "anthropic-claude-opus-4.6",
  ]) {
    const match = catalog.findModel({ vendorKey: "custom", modelId });
    assert.equal(match?.modelId, "claude-opus-4.6", modelId);
    assert.equal(match.reasoning, true);
  }
  for (const modelId of ["myproxy-claude-opus-4.6", "myproxy-claude-opus-4.6-thinking"]) {
    assert.equal(catalog.findModel({ vendorKey: "custom", modelId }), undefined);
  }
});

test("metadata lookup can share routed leaves and narrow suffix aliases without merging bindings", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { models: {
      "gateway-a/foo": { id: "gateway-a/foo" },
      "bar-agent": { id: "bar-agent" },
    } },
  });
  assert.equal(modelIdsMatch("gateway-a/foo", "gateway-b/foo"), false);
  assert.equal(modelIdsMatch("bar", "bar-agent"), false);
  assert.equal(catalog.findModel({ modelId: "gateway-b/foo" }), undefined);
  assert.equal(catalog.findModel({ modelId: "bar-thinking" })?.modelId, "bar-agent");
});

/*
  A gateway is indexed by models.dev under the vendor that owns the weights, so
  an endpoint serving `Vendor/Model` ids often has no record of its own while
  several other publishers state the identical id. Issue #938: those rows used
  to fall back to the generic 128k text-only shape, hiding a correct context
  window and tool support that the catalog does publish.
*/
test("an id the row's own catalog provider lacks borrows a unanimous exact-id record", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: { "gateway/own-model": { id: "gateway/own-model" } } },
    publisherA: { models: { "Vendor/Shared-Model-0731": {
      id: "Vendor/Shared-Model-0731", tool_call: true, reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      attachment: true, family: "shared",
      limit: { context: 262_144, output: 65_536 },
    } } },
    publisherB: { models: { "Vendor/Shared-Model-0731": {
      id: "Vendor/Shared-Model-0731", tool_call: true, reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      attachment: true, family: "shared",
      limit: { context: 1_048_576, output: 32_768 },
    } } },
  });
  const match = catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Shared-Model-0731",
  });
  assert.ok(match, "a published exact id must not drop to the generic shape");
  assert.equal(match.toolCall, true);
  assert.equal(match.reasoning, true);
  const info = modelInfoFromModelsDev(match, "provider-1");
  assert.equal(info.capabilities.includes("tools"), true);
  assert.equal(info.capabilities.includes("vision"), true);
  // Limits are the medians the publishers state; an even count takes the lower
  // middle, so a borrow never rounds a window up on its own.
  assert.equal(match.limit.context, 262_144);
  assert.equal(match.limit.output, 32_768);
});

test("a borrowed record under-claims instead of asserting one publisher's extras", async (t) => {
  // Both publishers agree on tool support, so the id is borrowable. They differ
  // on vision, reasoning and structured output, so none of those may be
  // reported: the borrow may only claim what every publisher states.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: { "gateway/own-model": { id: "gateway/own-model" } } },
    publisherA: { models: { "Vendor/Mixed": {
      id: "Vendor/Mixed", tool_call: true, reasoning: true, structured_output: true,
      modalities: { input: ["text", "image"], output: ["text"] }, attachment: true,
      limit: { context: 262_144 },
    } } },
    publisherB: { models: { "Vendor/Mixed": {
      id: "Vendor/Mixed", tool_call: true, reasoning: false, structured_output: false,
      modalities: { input: ["text"], output: ["text"] }, attachment: false,
      limit: { context: 262_144 },
    } } },
  });
  const match = catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Mixed",
  });
  assert.ok(match, "unanimous tool support is enough to borrow");
  assert.equal(match.toolCall, true);
  assert.equal(match.reasoning, false);
  // A capability the publishers do not state unanimously is left unasserted
  // (`undefined` means "no published answer"), never claimed from one source.
  assert.equal(match.structuredOutput, undefined);
  assert.equal(match.attachment, undefined);
  assert.deepEqual(match.modalities.input, ["text"]);
  const info = modelInfoFromModelsDev(match, "provider-1");
  assert.equal(info.capabilities.includes("vision"), false);
  assert.equal(info.capabilities.includes("reasoning"), false);
});

test("publishers split on tool support are not borrowed from at all", async (t) => {
  // Tool support is the gate: a wrong `true` would put tool declarations on the
  // wire that the endpoint may reject, so a split here refuses the borrow.
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: { "Vendor/Split": { id: "Vendor/Split", tool_call: true, limit: { context: 262_144 } } } },
    publisherB: { models: { "Vendor/Split": { id: "Vendor/Split", tool_call: false, limit: { context: 262_144 } } } },
  });
  assert.equal(
    catalog.findModel({
      vendorKey: "gateway",
      baseUrl: "https://gateway.example/v1",
      modelId: "Vendor/Split",
    }),
    undefined,
  );
});

test("a borrowed record never replaces what the row's own catalog provider publishes", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {
      "Vendor/Shared-Model": { id: "Vendor/Shared-Model", tool_call: false, limit: { context: 200_000 } },
    } },
    publisherA: { models: {
      "Vendor/Shared-Model": { id: "Vendor/Shared-Model", tool_call: true, limit: { context: 1_048_576 } },
    } },
  });
  const match = catalog.findModel({
    vendorKey: "gateway",
    baseUrl: "https://gateway.example/v1",
    modelId: "Vendor/Shared-Model",
  });
  assert.equal(match?.providerKey, "gateway");
  assert.equal(match.limit.context, 200_000);
  assert.equal(match.toolCall, false);
});

test("publishers that disagree about capabilities are not borrowed from", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: { "Vendor/Disputed": {
      id: "Vendor/Disputed", tool_call: true, reasoning: true, limit: { context: 262_144 },
    } } },
    publisherB: { models: { "Vendor/Disputed": {
      id: "Vendor/Disputed", tool_call: false, reasoning: false, limit: { context: 262_144 },
    } } },
  });
  assert.equal(
    catalog.findModel({
      vendorKey: "gateway",
      baseUrl: "https://gateway.example/v1",
      modelId: "Vendor/Disputed",
    }),
    undefined,
    "a disputed capability shape must not be resolved by picking one publisher",
  );
});

test("borrowing stays exact-id, provider-scoped and absent for unknown ids", async (t) => {
  const catalog = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: {
      "Vendor/Known": { id: "Vendor/Known", limit: { context: 262_144 } },
      "Vendor/Known-2507": { id: "Vendor/Known-2507", limit: { context: 131_072 } },
    } },
  });
  const input = { vendorKey: "gateway", baseUrl: "https://gateway.example/v1" };
  // A near-miss id is not a reason to reuse a sibling's limits.
  assert.equal(catalog.findModel({ ...input, modelId: "Vendor/Known-3000" }), undefined);
  assert.equal(catalog.findModel({ ...input, modelId: "Other/Known" }), undefined);
  assert.equal(catalog.findModel({ ...input, modelId: "unknown-model-xyz" }), undefined);
  // Exact ids still resolve, including a case-only difference.
  assert.equal(catalog.findModel({ ...input, modelId: "vendor/known" })?.limit.context, 262_144);
  assert.equal(catalog.findModel({ ...input, modelId: "Vendor/Known" })?.limit.context, 262_144);
  assert.equal(catalog.findModel({ ...input, modelId: "Vendor/Known-2507" })?.limit.context, 131_072);
  // The sibling exists under a different id, so nothing is borrowed through it.
  assert.equal(
    catalog.findModel({ ...input, modelId: "Vendor/Known-2507" })?.modelId,
    "Vendor/Known-2507",
  );
});

test("a provider sharing the row's endpoint owns its own negative answer", async (t) => {
  // Two names for one endpoint: an id published only by the sibling is not
  // borrowed, because that sibling was already consulted and does not list it.
  const catalog = await loadFixtureCatalog(t, {
    alpha: { api: "https://gateway.example/v1", models: { "alpha-only": { id: "alpha-only" } } },
    beta: { api: "https://gateway.example/v1", models: { "beta-only": { id: "beta-only" } } },
  });
  const input = { vendorKey: "beta", baseUrl: "https://gateway.example/v1" };
  assert.equal(catalog.findModel({ ...input, modelId: "alpha-only" }), undefined);
  // A different endpoint is a genuinely independent source and still transfers.
  const other = await loadFixtureCatalog(t, {
    gateway: { api: "https://gateway.example/v1", models: {} },
    publisherA: { models: { "Vendor/Elsewhere": { id: "Vendor/Elsewhere", limit: { context: 262_144 } } } },
  });
  assert.equal(
    other.findModel({
      vendorKey: "gateway",
      baseUrl: "https://gateway.example/v1",
      modelId: "Vendor/Elsewhere",
    })?.limit.context,
    262_144,
  );
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
    // Effort ladder without a published none/off value (#603).
    off: null,
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
    // Effort ladder without a published none/off value (#603).
    off: null,
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

test("models.dev parsing keeps the per-model wire API with a responses-only fallback", () => {
  const [provider, llmGateway] = parseModelsDevCatalog({
    "opencode-go": {
      name: "OpenCode Go",
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "muse-spark-1.3-contributor": { id: "muse-spark-1.3-contributor" },
        "deepseek-v4-flash": { id: "deepseek-v4-flash" },
        "custom-responses": { id: "custom-responses", api: "openai-responses" },
      },
    },
    "llmgateway": {
      name: "LLM Gateway",
      models: {
        "muse-spark-1.3-contributor": { id: "muse-spark-1.3-contributor" },
      },
    },
  });
  const byId = Object.fromEntries(provider.models.map((model) => [model.modelId, model]));
  assert.equal(byId["muse-spark-1.3-contributor"].modelApi, "openai-responses");
  assert.equal(byId["deepseek-v4-flash"].modelApi, undefined);
  assert.equal(byId["custom-responses"].modelApi, "openai-responses");
  const gatewayMuse = llmGateway.models.find((model) => model.modelId === "muse-spark-1.3-contributor");
  assert.equal(gatewayMuse.modelApi, undefined);
  const config = modelConfigFromModelsDev(
    byId["muse-spark-1.3-contributor"],
    "https://opencode.ai/zen/go/v1",
  );
  assert.equal(config.api, "openai-responses");
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

test("matches Zhipu and Z.AI endpoints by catalog URL and vendor aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-zhipu-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      zhipuai: {
        name: "Zhipu AI",
        api: "https://open.bigmodel.cn/api/paas/v4",
        models: {
          "glm-5": {
            id: "glm-5",
            name: "GLM-5",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 204_800, output: 131_072 },
          },
        },
      },
      "zhipuai-coding-plan": {
        name: "Zhipu AI Coding Plan",
        api: "https://open.bigmodel.cn/api/coding/paas/v4",
        models: {
          "glm-5.3": {
            id: "glm-5.3",
            name: "GLM-5.3",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
      zai: {
        name: "Z.AI",
        api: "https://api.z.ai/api/paas/v4",
        models: {
          "glm-5.1": {
            id: "glm-5.1",
            name: "GLM-5.1",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 200_000, output: 131_072 },
          },
        },
      },
      "zai-coding-plan": {
        name: "Z.AI Coding Plan",
        api: "https://api.z.ai/api/coding/paas/v4",
        models: {
          "glm-5.2": {
            id: "glm-5.2",
            name: "GLM-5.2",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    }),
    "utf8",
  );
  try {
    const catalog = new ModelsDevCatalog({ catalogPath });
    assert.equal(await catalog.ensureLoaded(), true);

    const chinaApi = catalog.findModel({
      vendorKey: "custom",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "glm-5",
    });
    assert.equal(chinaApi?.providerKey, "zhipuai");

    const chinaCoding = catalog.findModel({
      vendorKey: "zai-coding-cn",
      modelId: "glm-5.3",
    });
    assert.equal(chinaCoding?.providerKey, "zhipuai-coding-plan");
    assert.equal(chinaCoding?.modelId, "glm-5.3");

    const intlCoding = catalog.findModel({
      vendorKey: "custom",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      modelId: "glm-5.2",
    });
    assert.equal(intlCoding?.providerKey, "zai-coding-plan");
    assert.equal(
      catalog.providerKeyForRow({
        vendorKey: "bigmodel",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      }),
      "zhipuai",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps MiniMax OpenAI-compatible endpoints to multimodal catalog metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-models-dev-minimax-openai-"));
  const catalogPath = join(dir, "api.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      "minimax-cn": {
        name: "MiniMax (China)",
        api: "https://api.minimaxi.com/anthropic/v1",
        models: {
          "MiniMax-M3": {
            id: "MiniMax-M3",
            name: "MiniMax-M3",
            attachment: true,
            reasoning: true,
            modalities: { input: ["text", "image", "video"], output: ["text"] },
            limit: { context: 1_048_576, output: 524_288 },
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
      vendorKey: "custom",
      baseUrl: "https://api.minimaxi.com/v1",
      providerId: "custom-row",
    };
    const match = catalog.findModel({ ...input, modelId: "MiniMax-M3" });
    assert.equal(match?.providerKey, "minimax-cn");
    assert.deepEqual(match?.modalities.input, ["text", "image", "video"]);
    assert.equal(match?.attachment, true);
    assert.equal(catalog.modelsForProvider(input)[0]?.modelId, "MiniMax-M3");
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

test("toggle ladders still map off to none", () => {
  const [provider] = parseModelsDevCatalog({
    vendor: {
      name: "Vendor",
      models: {
        "toggle-model": {
          id: "toggle-model",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
        },
      },
    },
  });
  const info = modelInfoFromModelsDev(provider.models[0], "row");
  assert.equal(info.thinkingLevelMap?.off, "none");
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
    assert.equal(
      catalog.findModel({ vendorKey: "anthropic", modelId: "claude-opus-4.6" }),
      undefined,
      "a lookup before the bundled snapshot loads can miss",
    );
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

test("the bundled snapshot maps the latest 0.87.1 model ids to usable metadata", async () => {
  const catalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
  });
  assert.equal(await catalog.ensureLoaded(), true);

  const cases = [
    {
      vendorKey: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-6-sol",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    },
    {
      vendorKey: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-6-luna",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    },
    {
      vendorKey: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      vendorKey: "xai",
      baseUrl: "https://api.x.ai/v1",
      modelId: "grok-4.7",
      contextWindow: 500_000,
      maxTokens: 500_000,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
    },
  ];

  for (const expected of cases) {
    const model = catalog.findModel(expected);
    assert.ok(model, `${expected.vendorKey}/${expected.modelId} must be in the snapshot`);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevels, expected.thinkingLevels);
    assert.deepEqual(model.modalities.input, ["text", "image", "pdf"]);
    const config = modelConfigFromModelsDev(model, expected.baseUrl);
    assert.equal(config.contextWindow, expected.contextWindow);
    assert.equal(config.maxTokens, expected.maxTokens);
    assert.deepEqual(config.input, ["text", "image"]);
  }

  const copilotClaude = catalog.findModel({
    vendorKey: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    modelId: "claude-opus-5.5",
  });
  assert.ok(copilotClaude, "GitHub Copilot must include Claude Opus 5.5");
  assert.equal(copilotClaude.reasoning, true);
  assert.equal(copilotClaude.limit.context, 1_000_000);
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
        "claude-opus-4.6": {
          ...catalogFixture.anthropic.models["claude-opus-4.6"],
          name: "Updated Claude",
        },
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
    const existingInput = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
    const previousMatch = catalog.findModel(existingInput);
    assert.ok(previousMatch);
    assert.equal(catalog.findModel({ vendorKey: "anthropic", modelId: "new-model" }), undefined);
    assert.equal(calls.length, 0);
    assert.equal(await catalog.refresh(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, MODELS_DEV_API_URL);
    assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
    const refreshedMatch = catalog.findModel(existingInput);
    assert.notEqual(refreshedMatch, previousMatch);
    assert.equal(refreshedMatch?.displayName, "Updated Claude");
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
    const input = { vendorKey: "anthropic", modelId: "claude-opus-4.6" };
    const match = catalog.findModel(input);
    assert.ok(match);
    const reads = observeModelIdReads(match);
    const missing = { ...input, modelId: "unpublished-model" };
    assert.equal(catalog.findModel(missing), undefined);
    const beforeRefresh = reads();
    assert.equal(await catalog.refresh(), false);
    assert.equal(catalog.findModel(input), match);
    assert.equal(catalog.findModel(missing), undefined);
    assert.equal(reads(), beforeRefresh, "a failed refresh preserves both cached matches and misses");
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
