import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { createCatalogRuntime, providerModelRetryDelayMs } = await import("../src/stores/runtime/catalog-runtime.ts");
const { api } = await import("../src/lib/api.ts");

// Based on the reproduction in #2232 by yg2224.

function harness(models = []) {
  let state = { providerModels: { provider: models } };
  const catalogRuntime = createCatalogRuntime();
  const slice = createCatalogSlice({
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    catalogRuntime,
  });
  Object.assign(state, slice);
  return { slice, catalogRuntime, state: () => state };
}

function liveCalls(mock) {
  return mock.mock.calls.filter(call => call.arguments[0]?.source === "refresh").length;
}

for (const cached of [[], [{ modelId: "cached" }]]) {
  test(`a failed live discovery is retried after its backoff (cached=${cached.length})`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness(cached);
    const discovered = [{ modelId: "new-model" }];
    let live = 0;
    const listing = t.mock.method(api, "listProviderModels", async ({ source }) => {
      if (source === "cache") return { models: cached, source: "cache" };
      if (++live === 1) throw new Error("temporary network failure");
      return { models: discovered, source: "remote" };
    });
    await h.slice.loadProviderModels("provider");
    assert.deepEqual(h.state().providerModels.provider, cached);

    await h.slice.loadProviderModels("provider");
    assert.equal(liveCalls(listing), 1, "reopening within the backoff does not probe again");

    t.mock.timers.tick(providerModelRetryDelayMs(1));
    await h.slice.loadProviderModels("provider");
    assert.deepEqual(h.state().providerModels.provider, discovered);

    t.mock.timers.tick(providerModelRetryDelayMs(10));
    await h.slice.loadProviderModels("provider");
    assert.equal(liveCalls(listing), 2, "a successful discovery remains memoized");
  });
}

test("a fallback carrying a discovery error is retried, with growing backoff", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const h = harness([{ modelId: "cached" }]);
  let succeed = false;
  const listing = t.mock.method(api, "listProviderModels", async () => succeed
    ? { models: [{ modelId: "new-model" }], source: "remote" }
    : { models: [{ modelId: "catalog" }], source: "catalog", error: "gateway unavailable" });
  await h.slice.loadProviderModels("provider");
  t.mock.timers.tick(providerModelRetryDelayMs(1));
  await h.slice.loadProviderModels("provider");
  assert.equal(liveCalls(listing), 2);

  // The second failure waits longer than the first.
  t.mock.timers.tick(providerModelRetryDelayMs(1));
  await h.slice.loadProviderModels("provider");
  assert.equal(liveCalls(listing), 2);
  t.mock.timers.tick(providerModelRetryDelayMs(2) - providerModelRetryDelayMs(1));
  succeed = true;
  await h.slice.loadProviderModels("provider");
  assert.equal(liveCalls(listing), 3);
  assert.equal(h.state().providerModels.provider[0].modelId, "new-model");
});

test("callers coalesced onto a failed discovery do not each start another probe", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const h = harness([{ modelId: "cached" }]);
  let finish;
  const listing = t.mock.method(api, "listProviderModels", ({ source }) => source === "cache"
    ? Promise.resolve({ models: [{ modelId: "cached" }], source: "cache" })
    : new Promise(resolve => { finish = resolve; }));
  const callers = [1, 2, 3, 4].map(() => h.slice.loadProviderModels("provider"));
  await new Promise(resolve => setImmediate(resolve));
  finish({ models: [], source: "fallback", error: "unreachable" });
  await Promise.all(callers);
  assert.equal(liveCalls(listing), 1);
});

test("a provider refresh clears the backoff", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const h = harness([{ modelId: "cached" }]);
  const listing = t.mock.method(api, "listProviderModels", async () =>
    ({ models: [], source: "fallback", error: "bad key" }));
  await h.slice.loadProviderModels("provider");
  h.catalogRuntime.beginProviderRefresh();
  await h.slice.loadProviderModels("provider");
  assert.equal(liveCalls(listing), 2);
});

test("the retry delay grows and is capped", () => {
  assert.equal(providerModelRetryDelayMs(1), 10_000);
  assert.equal(providerModelRetryDelayMs(2), 20_000);
  assert.ok(providerModelRetryDelayMs(3) > providerModelRetryDelayMs(2));
  assert.equal(providerModelRetryDelayMs(50), 5 * 60_000);
});
