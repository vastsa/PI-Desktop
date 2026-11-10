import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { createCatalogRuntime } = await import("../src/stores/runtime/catalog-runtime.ts");
const { api } = await import("../src/lib/api.ts");

function harness(models = []) {
  let state = { providerModels: { provider: models } };
  const catalogRuntime = createCatalogRuntime();
  const slice = createCatalogSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, catalogRuntime });
  Object.assign(state, slice);
  return { slice, catalogRuntime, state: () => state };
}

for (const cached of [[], [{ modelId: "cached" }]]) {
  test(`a failed live discovery can retry without resetting providers (cached=${cached.length})`, async t => {
    const h = harness(cached);
    let liveCalls = 0;
    const discovered = [{ modelId: "new-model" }];
    t.mock.method(api, "listProviderModels", async ({ source }) => {
      if (source === "cache") return { models: cached, source: "cache" };
      if (++liveCalls === 1) throw new Error("temporary network failure");
      return { models: discovered, source: "remote" };
    });
    await h.slice.loadProviderModels("provider");
    assert.deepEqual(h.state().providerModels.provider, cached);
    await h.slice.loadProviderModels("provider");
    assert.deepEqual(h.state().providerModels.provider, discovered);
    await h.slice.loadProviderModels("provider");
    assert.equal(liveCalls, 2, "a successful discovery remains memoized");
  });
}

test("a discovery fallback carrying an error remains retryable", async t => {
  const cached = [{ modelId: "cached" }];
  const h = harness(cached);
  let attempts = 0;
  t.mock.method(api, "listProviderModels", async () => ++attempts === 1
    ? { models: cached, source: "fallback", error: "gateway unavailable" }
    : { models: [{ modelId: "new-model" }], source: "remote" });
  await h.slice.loadProviderModels("provider");
  await h.slice.loadProviderModels("provider");
  assert.equal(h.state().providerModels.provider[0].modelId, "new-model");
});
