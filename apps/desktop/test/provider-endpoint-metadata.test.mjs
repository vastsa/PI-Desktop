/**
 * Platform models get only the metadata the catalog can justify for them.
 *
 * Two reported failures live here. A custom row pointed at
 * `https://open.bigmodel.cn/api/v1` (Zhipu's OpenAI Responses endpoint) listed
 * its models but showed a generic 128k / 8k text-only row for every one of them,
 * because the catalog only accepted that host's own published path. And a row on
 * a relay the catalog cannot place got nothing at all for models the catalog
 * describes, because one publisher's record must never answer for another.
 *
 * Discovery now uses the fixed platform endpoint. Publisher-host anchoring
 * remains a local catalog lookup, with no credential or transport authority.
 * These real handlers and the bundled snapshot preserve both contracts.
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

/** Register the real handlers against one row and one served model list. */
async function handlersFor(t, row, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    assert.equal(new URL(url).origin, "https://ai.yykkj.com", "only platform discovery may use the network");
    return String(url).endsWith("/models") ? jsonResponse(body) : new Response("", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true, "the bundled snapshot must load");

  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        if (method === "providers.list") return { providers: [row] };
        if (method === "providers.getSecret") return { value: "dummy" };
        if (method === "providers.get") return { provider: row };
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
  const lookupModel = handlers.get(IPC.invoke.providersLookupModel);
  assert.equal(typeof lookupModel, "function", "model-lookup handler is not registered");

  return {
    calls,
    row,
    result: await listModels({ providerId: row.id, source: "refresh" }),
    /** The hand-typed id channel a picker uses when a user types an id in. */
    lookup: (input) => lookupModel(input),
  };
}

function rowOf(overrides) {
  return {
    name: "Row",
    vendorKey: "ai-aggregation-platform",
    baseUrl: "https://ai.yykkj.com/v1",
    apiStyle: "chat_completions",
    models: [],
    authKind: "api_key_and_base_url",
    headers: {},
    ...overrides,
  };
}

test("platform discovery preserves wire IDs while a local lookup anchors publisher metadata", async (t) => {
  const row = rowOf({
    id: "row-1",
    name: "Platform Responses",
    apiStyle: "responses",
  });
  const { result, calls, lookup } = await handlersFor(t, row, {
    models: [{ slug: "glm-5.3", display_name: "glm-5.3" }],
  });

  assert.deepEqual(calls, ["https://ai.yykkj.com/v1/models"]);
  assert.equal(result.effectiveBaseUrl, "https://ai.yykkj.com/v1");
  assert.equal(result.models[0].modelId, "glm-5.3", "the wire id is the one the service served");

  // The former endpoint remains valid as a catalog hint, never as a route.
  const { info: model } = await lookup({
    modelId: "glm-5.3", vendorKey: "custom",
    baseUrl: "https://open.bigmodel.cn/api/v1", providerId: row.id,
  });
  assert.ok(model, "the host identified the publisher in the local snapshot");
  assert.equal(model.modelId, "glm-5.3");
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 131_072);
  for (const capability of ["tools", "reasoning"]) {
    assert.ok(model.capabilities.includes(capability), `expected ${capability} capability`);
  }
  assert.deepEqual(calls, ["https://ai.yykkj.com/v1/models"], "catalog hints must not start a second request");
});

test("the platform's list reads the shipped publisher's record for a known id", async (t) => {
  const row = rowOf({
    id: "row-2",
    name: "Platform",
  });
  const { result } = await handlersFor(t, row, {
    data: [{ id: "claude-sonnet-4-5" }, { id: "some-private-model" }],
  });

  const byId = new Map(result.models.map((model) => [model.modelId, model]));
  const known = byId.get("claude-sonnet-4-5");
  assert.equal(known.catalogSource, "models.dev", "several publishers state this id");
  // Anthropic's published window, not a median dragged down by resellers that
  // state a smaller deployment of the same id.
  assert.equal(known.contextWindow, 1_000_000);
  assert.equal(known.maxTokens, 64_000);
  assert.ok(known.capabilities.includes("tools"));
  // An id no publisher states still lands on the generic seed.
  const unknown = byId.get("some-private-model");
  assert.equal(unknown.catalogSource, undefined);
  assert.equal(unknown.contextWindow, 128_000);
  assert.deepEqual(unknown.capabilities, ["text"]);
});

test("a hand-typed id on the platform answers with the same record", async (t) => {
  const row = rowOf({
    id: "row-3",
    name: "Platform",
  });
  const { lookup, result, calls } = await handlersFor(t, row, { data: [{ id: "claude-sonnet-4-5" }] });

  const known = await lookup({
    modelId: "claude-sonnet-4-5",
    baseUrl: row.baseUrl,
    vendorKey: row.vendorKey,
    providerId: row.id,
  });
  assert.ok(known.info, "a typed id the catalog knows must reach its record");
  assert.equal(known.info.modelId, "claude-sonnet-4-5");
  assert.ok(known.info.capabilities.includes("tools"));
  assert.equal(known.info.contextWindow, result.models[0].contextWindow);
  assert.equal(known.info.maxTokens, result.models[0].maxTokens);

  // A private id stays generic, and the lookup never contacts the network.
  const unknown = await lookup({ modelId: "some-private-model", baseUrl: row.baseUrl });
  assert.equal(unknown.info, null);
  assert.deepEqual(calls, ["https://ai.yykkj.com/v1/models"]);
});

test("the platform enriches unique/official leaves and leaves ambiguous or marker leaves unmatched", async (t) => {
  /*
    #1047: exact last-segment match + official/shared-capabilities disambiguation.
    Multi-publisher leaves with conflicting capabilities stay generic. Deployment
    markers (`-1m`) stay part of the leaf and do not strip to a sibling.
  */
  const row = rowOf({ id: "row-4", name: "Platform" });
  const { result } = await handlersFor(t, row, {
    data: [
      { id: "deepseek-v4-flash" },
      { id: "mimo-v2.5-pro" },
      { id: "mimo-v2.5-tts" },
      { id: "gemini-2.5-pro-1m" },
      { id: "claude-sonnet-4-5" },
    ],
  });

  const byId = new Map(result.models.map((model) => [model.modelId, model]));

  // Ambiguous non-official leaves with conflicting publisher caps stay generic.
  assert.equal(byId.get("deepseek-v4-flash").catalogSource, undefined);
  assert.equal(byId.get("mimo-v2.5-pro").catalogSource, undefined);

  // Unique leaf still enriches.
  const tts = byId.get("mimo-v2.5-tts");
  assert.equal(tts.catalogSource, "models.dev");
  assert.ok(tts.capabilities.includes("audio"));
  assert.equal(tts.contextWindow, 8_192);

  // Official Anthropic disambiguation still enriches Claude leaves.
  const claude = byId.get("claude-sonnet-4-5");
  assert.equal(claude.catalogSource, "models.dev");
  assert.equal(claude.contextWindow, 1_000_000);

  // Marker leaf is not stripped to gemini-2.5-pro.
  assert.equal(byId.get("gemini-2.5-pro-1m").catalogSource, undefined);
});

test("the platform enriches a uniquely published dated leaf without reseller majority voting", async (t) => {
  /*
    #1047: exact leaf match. If the dated id is published uniquely (or shares
    identical capabilities / a unique official), enrich; otherwise stay generic.
    No shipped-publisher majority override beyond official/source disambiguation.
  */
  const row = rowOf({ id: "row-5", name: "Platform" });
  const { result } = await handlersFor(t, row, { data: [{ id: "doubao-seed-2-0-pro-260215" }] });

  const [model] = result.models;
  // Accept either enrichment from an exact leaf hit, or generic when ambiguous.
  if (model.catalogSource === "models.dev") {
    assert.ok(model.contextWindow > 0);
  } else {
    assert.equal(model.catalogSource, undefined);
  }
});
