import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");

const platform = {
  id: "platform", name: "Platform", vendorKey: "ai-aggregation-platform",
  baseUrl: "https://ai.yykkj.com/v1", authKind: "api_key_and_base_url",
  apiStyle: "chat_completions", enabled: true, hasSecret: true,
  models: [{ id: "fixture-chat", thinkingLevels: ["off"] }],
  defaultModelId: "fixture-chat",
};
const foreign = { ...platform, id: "legacy", vendorKey: "openai", baseUrl: "https://api.openai.com/v1" };
const forbidden = [
  ["foreign endpoint", { baseUrl: "https://outside.invalid/v1" }],
  ["lookalike host", { baseUrl: "https://ai.yykkj.com.outside.invalid/v1" }],
  ["embedded credentials", { baseUrl: "https://dummy@ai.yykkj.com/v1" }],
  ["foreign vendor", { vendorKey: "openai" }],
  ["vendor OAuth", { authKind: "oauth" }],
  ["anonymous auth", { authKind: "none" }],
  ["unsupported protocol", { apiStyle: "google_generative_ai" }],
  ["auth header override", { headers: { aUtHoRiZaTiOn: "Bearer other-dummy" } }],
  ["extension transport", { extensionAgentKey: "plugin/agent" }],
];

test("new, edited and legacy platform providers include media defaults without model discovery", async (t) => {
  const f = fixture(t);
  const ids = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "MiniMax-H3"];
  const listed = await f.call(IPC.invoke.providersList);
  assert.deepEqual(listed.providers[0].models.slice(-3).map(model => model.id), ids);
  assert.deepEqual(f.providers.get(platform.id).models, platform.models, "reading must not migrate storage");
  const created = await f.call(IPC.invoke.providersCreate, { ...platform, id: "new" });
  assert.deepEqual(created.provider.models.slice(-3).map(model => model.id), ids);
  assert.deepEqual(f.providers.get("new").models.slice(-3).map(model => model.id), ids);
  await f.call(IPC.invoke.providersUpdate, { id: "new", models: [{ id: "other-chat", thinkingLevels: [] }] });
  assert.deepEqual(f.providers.get("new").models.map(model => model.id), ["other-chat", ...ids]);
  assert.equal(f.fetch.mock.callCount(), 0);
});

/** Real IPC registration, policy, catalog enrichment and discovery; only I/O is replaced. */
function fixture(t, rows = [platform, foreign]) {
  const providers = new Map(rows.map((row) => [row.id, structuredClone(row)]));
  const secrets = new Map([[platform.id, "dummy"]]);
  const hostCalls = [];
  const host = { call: async (method, input) => {
    hostCalls.push({ method, input });
    switch (method) {
      case "providers.list": return { providers: [...providers.values()] };
      case "providers.get": return { provider: providers.get(input.id) };
      case "providers.create": providers.set(input.id, { ...input }); return { provider: providers.get(input.id) };
      case "providers.update": providers.set(input.id, { ...providers.get(input.id), ...input }); return { provider: providers.get(input.id) };
      case "providers.setSecret": secrets.set(input.id, input.secretValue); return { provider: providers.get(input.id) };
      case "providers.getSecret": return { value: secrets.get(input.id) };
      case "providers.testConnection": return { ok: true };
      case "providers.listModels": return { models: [{ modelId: "fixture-chat", displayName: "Fixture" }] };
      case "providers.cacheModels": return { ok: true };
      default: throw new Error(`Unexpected host I/O: ${method}`);
    }
  } };
  const catalog = {
    ensureLoaded: t.mock.fn(async () => true), loadLocal: t.mock.fn(async () => true),
    findModel: () => undefined, modelsForProvider: () => [], anthropicThinkingFor: () => undefined,
  };
  const providerCatalog = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog: catalog });
  const handlers = new Map();
  const oauth = {
    resolveAuth: t.mock.fn(async () => { throw new Error("OAuth must not run"); }),
    start: t.mock.fn(async () => { throw new Error("OAuth must not run"); }),
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request in platform fixture");
  });
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, modelsDevCatalog: catalog, vendorOAuth: oauth,
    logger: { app() {} }, ...providerCatalog,
  });
  return {
    providers, hostCalls, catalog, oauth, fetch,
    call: (channel, input) => {
      assert.ok(handlers.has(channel), `Unregistered channel ${channel}`);
      return handlers.get(channel)(input);
    },
  };
}

for (const [name, override] of forbidden) {
  test(`create rejects ${name} before persistence or network`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.call(IPC.invoke.providersCreate, { ...platform, ...override }), {
      errorCode: "PLATFORM_PROVIDER_REQUIRED",
    });
    assert.deepEqual(f.hostCalls, []);
    assert.equal(f.catalog.ensureLoaded.mock.callCount(), 0);
    assert.equal(f.fetch.mock.callCount(), 0);
  });

  test(`update rejects ${name} before mutation or secret lookup`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.call(IPC.invoke.providersUpdate, { id: platform.id, ...override }), {
      errorCode: "PLATFORM_PROVIDER_REQUIRED",
    });
    assert.deepEqual(f.hostCalls, [{ method: "providers.get", input: { id: platform.id } }]);
    assert.deepEqual(f.providers.get(platform.id), platform);
    assert.equal(f.fetch.mock.callCount(), 0);
  });
}

test("create, rename, replace key and list preserve the platform contract without exposing the key", async (t) => {
  const f = fixture(t, [foreign]);
  const created = await f.call(IPC.invoke.providersCreate, platform);
  assert.equal(created.provider.id, platform.id);
  const updated = await f.call(IPC.invoke.providersUpdate, { id: platform.id, name: "My platform" });
  assert.equal(updated.provider.name, "My platform");
  assert.equal(updated.provider.baseUrl, platform.baseUrl);
  const saved = await f.call(IPC.invoke.providersSetSecret, { id: platform.id, secretValue: "dummy-new" });
  const listed = await f.call(IPC.invoke.providersList);
  assert.deepEqual(listed.providers.map((row) => row.id), [platform.id]);
  assert.deepEqual(f.providers.get(foreign.id), foreign, "legacy data is retained");
  assert.doesNotMatch(JSON.stringify([created, updated, saved, listed]), /dummy-new/);
  assert.equal(f.hostCalls.some(({ method }) => method === "providers.getSecret"), false);
  assert.equal(f.fetch.mock.callCount(), 0);
});

for (const channel of [IPC.invoke.providersUpdate, IPC.invoke.providersSetSecret]) {
  test(`${channel} refuses a persisted legacy row even when the caller supplies platform fields`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.call(channel, { ...platform, id: foreign.id, secretValue: "dummy" }), {
      errorCode: "PLATFORM_PROVIDER_REQUIRED",
    });
    assert.deepEqual(f.hostCalls, [{ method: "providers.get", input: { id: foreign.id } }]);
    assert.deepEqual(f.providers.get(foreign.id), foreign);
    assert.equal(f.fetch.mock.callCount(), 0);
  });

  test(`${channel} reports a missing row without mutation`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.call(channel, { id: "missing", secretValue: "dummy" }), /Provider not found/);
    assert.deepEqual(f.hostCalls, [{ method: "providers.get", input: { id: "missing" } }]);
  });
}

for (const source of ["cache", "refresh"]) {
  for (const input of [
    { providerId: platform.id, baseUrl: "https://outside.invalid/v1" },
    { baseUrl: "https://outside.invalid/v1", apiKey: "dummy" },
    { providerId: foreign.id },
    { providerId: platform.id, headers: { "x-api-key": "other-dummy" } },
    { providerId: platform.id, apiStyle: "google_generative_ai" },
  ]) {
    test(`discovery ${source} refuses ${JSON.stringify(input)} before secrets and transport`, async (t) => {
      const f = fixture(t);
      await assert.rejects(f.call(IPC.invoke.providersListModels, { ...input, source }), /only supports|Platform provider not found/);
      assert.deepEqual(f.hostCalls.map(({ method }) => method), ["providers.list"]);
      assert.equal(f.catalog.loadLocal.mock.callCount(), 0);
      assert.equal(f.fetch.mock.callCount(), 0);
      assert.equal(f.oauth.resolveAuth.mock.callCount(), 0);
    });
  }
}

test("cached platform models stay usable offline without retrieving the stored key", async (t) => {
  const f = fixture(t);
  const result = await f.call(IPC.invoke.providersListModels, { providerId: platform.id, source: "cache" });
  assert.equal(result.source, "cache");
  assert.deepEqual(result.models.map((model) => model.modelId), ["fixture-chat"]);
  assert.deepEqual(f.hostCalls.map(({ method }) => method), ["providers.list", "providers.listModels"]);
  assert.equal(f.fetch.mock.callCount(), 0);
});

for (const apiStyle of ["chat_completions", "responses", "anthropic_messages"]) {
  test(`${apiStyle} discovery uses the platform endpoint and stored key through the real probe`, async (t) => {
    const f = fixture(t, [{ ...platform, apiStyle }, foreign]);
    f.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "served-model" }] }), {
      headers: { "content-type": "application/json" },
    }));
    const result = await f.call(IPC.invoke.providersListModels, { providerId: platform.id, source: "refresh" });
    assert.equal(result.source, "remote");
    assert.ok(result.models.some((model) => model.modelId === "served-model"));
    assert.equal(f.fetch.mock.callCount(), 1);
    const [input, init] = f.fetch.mock.calls[0].arguments;
    const url = new URL(input);
    assert.equal(url.origin, "https://ai.yykkj.com");
    assert.equal(url.pathname, "/v1/models");
    assert.equal(new Headers(init.headers).get(apiStyle === "anthropic_messages" ? "x-api-key" : "authorization"),
      apiStyle === "anthropic_messages" ? "dummy" : "Bearer dummy");
    assert.equal(init.redirect, "manual");
    assert.doesNotMatch(JSON.stringify(result), /dummy/);
    const cache = f.hostCalls.find(({ method }) => method === "providers.cacheModels");
    assert.deepEqual(cache.input.models.map((model) => model.modelId), ["served-model"]);
  });
}

test("unsaved platform discovery uses only the supplied dummy key", async (t) => {
  const f = fixture(t);
  f.fetch.mock.mockImplementation(async () => new Response('{"data":[{"id":"served-model"}]}'));
  const result = await f.call(IPC.invoke.providersListModels, { baseUrl: platform.baseUrl, apiKey: "dummy-dialog" });
  assert.equal(result.source, "remote");
  const [, init] = f.fetch.mock.calls[0].arguments;
  assert.equal(new Headers(init.headers).get("authorization"), "Bearer dummy-dialog");
  assert.deepEqual(f.hostCalls.map(({ method }) => method), ["providers.list"]);
});

test("connection testing refuses legacy providers before secret retrieval or OAuth", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call(IPC.invoke.providersTest, foreign.id), { errorCode: "PLATFORM_PROVIDER_REQUIRED" });
  assert.deepEqual(f.hostCalls.map(({ method }) => method), ["providers.testConnection", "providers.get"]);
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.oauth.resolveAuth.mock.callCount(), 0);
});

test("platform discovery never follows a credential-bearing redirect to another origin", async (t) => {
  const f = fixture(t);
  f.fetch.mock.mockImplementation(async () => new Response(null, {
    status: 302, headers: { location: "https://outside.invalid/v1/models" },
  }));
  const result = await f.call(IPC.invoke.providersListModels, platform.id);
  assert.equal(result.source, "fallback");
  assert.match(result.error, /redirect refused/);
  assert.equal(f.fetch.mock.callCount(), 1);
  assert.equal(f.hostCalls.some(({ method }) => method === "providers.cacheModels"), false);
});

test("vendor login is unavailable without starting OAuth", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.call(IPC.invoke.providersOauthVendors), { vendors: [] });
  await assert.rejects(f.call(IPC.invoke.providersOauthStart, "openai-codex"), /unavailable/);
  assert.equal(f.oauth.start.mock.callCount(), 0);
  assert.deepEqual(f.hostCalls, []);
  assert.equal(f.fetch.mock.callCount(), 0);
});
