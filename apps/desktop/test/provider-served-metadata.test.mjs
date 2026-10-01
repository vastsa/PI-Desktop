/**
 * A gateway's own model list fills the generic shape, and only the generic shape.
 *
 * Eden AI addresses every model as `provider/model` and its `/models` answer
 * states a window and capability flags per row. Most of those ids match no
 * published record, so before this they landed on the generic 128k text-only
 * seed even though the service had just said otherwise. This drives the real
 * handler with an Eden-shaped list and pins the two facts that are taken from
 * the service, the facts that are deliberately not, and that a published record
 * still outranks whatever the list says about a known id.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { IPC } = await import("@pi-desktop/shared");

const catalogPath = new URL("../resources/models.dev/api.json", import.meta.url).pathname;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One Eden AI catalog row, in the shape the live endpoint returns. */
function edenRow(id, overrides = {}) {
  return {
    id,
    object: "model",
    owned_by: id.split("/")[0],
    model_name: id.split("/").at(-1),
    context_length: 131_072,
    capabilities: {
      input_modalities: ["text"],
      output_modalities: ["text"],
      supports_function_calling: true,
      supports_reasoning: false,
      supports_native_streaming: false,
    },
    pricing: { input_cost_per_token: 3e-8, output_cost_per_token: 1e-7 },
    ...overrides,
  };
}

/** Register the real handlers against one row and record what the cache is told. */
async function handlersFor(t, row, body) {
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true, "the bundled snapshot must load");

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return String(url).endsWith("/models") ? jsonResponse(body) : new Response("", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const cached = [];
  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method, params) => {
        if (method === "providers.list") return { providers: [row] };
        if (method === "providers.getSecret") return { value: "eden-fixture-key" };
        if (method === "providers.get") return { provider: row };
        if (method === "providers.cacheModels") {
          cached.push(...params.models);
          return { cached: params.models.length, models: [] };
        }
        if (method === "providers.listModels") return { models: cached };
        return {};
      },
    }),
    modelsDevCatalog: catalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [row],
    enrichProviderList: (result) => result,
    bindingForModel: () => undefined,
  });

  const listModels = handlers.get(IPC.invoke.providersListModels);
  assert.equal(typeof listModels, "function", "list-models handler is not registered");
  return {
    calls,
    cached,
    live: () => listModels({ providerId: row.id, source: "refresh" }),
    fromCache: () => listModels({ providerId: row.id, source: "cache" }),
  };
}

const edenProvider = {
  id: "eden-row",
  name: "Eden AI",
  vendorKey: "edenai",
  baseUrl: "https://api.edenai.run/v3",
  apiStyle: "chat_completions",
  models: [],
  authKind: "api_key_and_base_url",
  headers: {},
};

test("an Eden AI list is probed at /v3/models with the stored key and read verbatim", async (t) => {
  const { live, calls } = await handlersFor(t, edenProvider, {
    object: "list",
    data: [
      edenRow("deepinfra/meta-llama/Llama-3.3-70B-Instruct"),
      edenRow("greenference/greenference/gemma-4-31b-it", { context_length: 32_768 }),
      edenRow("openai/gpt-latest", { context_length: 400_000 }),
    ],
  });
  const result = await live();

  assert.deepEqual(calls, [
    { url: "https://api.edenai.run/v3/models", authorization: "Bearer eden-fixture-key" },
  ]);
  assert.equal(result.source, "remote");
  assert.equal(result.effectiveBaseUrl, "https://api.edenai.run/v3");
  assert.deepEqual(
    result.models.map((model) => model.modelId),
    [
      "deepinfra/meta-llama/Llama-3.3-70B-Instruct",
      "greenference/greenference/gemma-4-31b-it",
      "openai/gpt-latest",
    ],
    "routed ids, including three-segment routes, are the wire ids",
  );
});

test("the served window and tool support fill a generic row; image and reasoning stay conservative", async (t) => {
  const { live } = await handlersFor(t, edenProvider, {
    data: [
      // A gateway alias no publisher lists, so nothing but the served row describes it.
      edenRow("vertex/gemini-fixture-alias-latest", {
        context_length: 1_048_576,
        capabilities: {
          input_modalities: ["text", "image", "file"],
          output_modalities: ["text"],
          supports_function_calling: true,
          supports_reasoning: true,
        },
      }),
      edenRow("scaleway/some-private-model", {
        context_length: 32_000,
        capabilities: { input_modalities: ["text"], supports_function_calling: false },
      }),
      // A row that states nothing about itself keeps the generic seed entirely.
      { id: "ovhcloud/bare-row" },
    ],
  });
  const byId = new Map((await live()).models.map((model) => [model.modelId, model]));

  const gemini = byId.get("vertex/gemini-fixture-alias-latest");
  assert.equal(gemini.catalogSource, undefined, "no published record claims this alias");
  assert.equal(gemini.contextWindow, 1_048_576, "the served window sizes the row");
  assert.equal(gemini.maxTokens, 8_192, "no served output cap, so the generic cap stays");
  assert.ok(gemini.capabilities.includes("tools"));
  assert.equal(gemini.toolCall, true);
  // Image and reasoning are request-shape changes gated by the user's binding;
  // a gateway flag alone does not promote them.
  assert.deepEqual(gemini.modalities, { input: ["text"], output: ["text"] });
  assert.equal(gemini.reasoning, false);
  assert.ok(!gemini.capabilities.includes("vision"));
  assert.ok(!gemini.capabilities.includes("reasoning"));

  const private_ = byId.get("scaleway/some-private-model");
  assert.equal(private_.contextWindow, 32_000);
  assert.ok(!private_.capabilities.includes("tools"), "an explicit false is not a claim");
  assert.equal(private_.toolCall, undefined);

  const bare = byId.get("ovhcloud/bare-row");
  assert.equal(bare.contextWindow, 128_000);
  assert.deepEqual(bare.capabilities, ["text"]);
});

test("a published record still wins over what the gateway list says about a known id", async (t) => {
  const { live } = await handlersFor(t, edenProvider, {
    data: [
      // Eden serves Anthropic's dated id; the list understates its window and
      // omits tools, and the published record is what the row must show.
      edenRow("anthropic/claude-sonnet-4-5", {
        context_length: 4_096,
        capabilities: { input_modalities: ["text"], supports_function_calling: false },
      }),
    ],
  });
  const [model] = (await live()).models;
  assert.equal(model.modelId, "anthropic/claude-sonnet-4-5", "the wire id keeps its route");
  assert.equal(model.catalogSource, "pi");
  assert.equal(model.contextWindow, 1_000_000);
  assert.ok(model.capabilities.includes("tools"));
});

test("the cache carries the served window and tool support back to the next read", async (t) => {
  const { live, fromCache, cached } = await handlersFor(t, edenProvider, {
    data: [edenRow("mistral/fixture-private-2099", { context_length: 262_144 })],
  });
  await live();
  assert.equal(cached.length, 1, "the live answer is written to the durable cache");
  assert.equal(cached[0].contextWindow, 262_144);
  assert.ok(cached[0].capabilities.includes("tools"));

  const [row] = (await fromCache()).models;
  assert.equal(row.contextWindow, 262_144, "a cache read shows the served window");
  assert.ok(row.capabilities.includes("tools"));
  assert.equal(row.toolCall, true);
});

test("the EU host is probed on its own origin and reads the same way", async (t) => {
  const { live, calls } = await handlersFor(
    t,
    { ...edenProvider, id: "eden-eu-row", baseUrl: "https://api.eu.edenai.run/v3" },
    { data: [edenRow("mistral/fixture-private-2099", { context_length: 262_144 })] },
  );
  const result = await live();
  assert.deepEqual(calls.map((call) => call.url), ["https://api.eu.edenai.run/v3/models"]);
  assert.equal(result.models[0].contextWindow, 262_144);
});
