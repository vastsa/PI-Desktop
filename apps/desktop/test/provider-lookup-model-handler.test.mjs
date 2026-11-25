/**
 * Contract test for the custom-model library lookup.
 *
 * A hand-typed custom id exists nowhere in any provider's list, so the settings
 * picker reads the local models.dev snapshot through one dedicated channel.
 * This pins the handler contract: it loads the snapshot, resolves the id,
 * echoes the provider back on the record, answers a miss with `null`, and never
 * touches the host or the network.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");

function harness(t) {
  const requests = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the lookup must not probe the network");
  });
  t.after(() => assert.equal(requests.mock.callCount(), 0));
  const catalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
  });
  const handlers = new Map();
  const hostCalls = [];
  const ensureLoaded = t.mock.method(catalog, "ensureLoaded");
  const publishedModelFor = t.mock.method(catalog, "publishedModelFor");
  const findModel = t.mock.method(catalog, "findModel");
  const settingsMetadataFor = t.mock.method(catalog, "settingsMetadataFor");
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        hostCalls.push(method);
        throw new Error("the lookup must not call the host");
      },
    }),
    modelsDevCatalog: catalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [],
    enrichProviderList: async (result) => result,
    bindingForModel: () => undefined,
  });
  const handler = handlers.get(IPC.invoke.providersLookupModel);
  assert.equal(typeof handler, "function", "lookup handler is not registered");
  return { call: (input) => handler(input), ensureLoaded, publishedModelFor, findModel, settingsMetadataFor, hostCalls };
}

test("a published id returns the models.dev record for the typed id", async (t) => {
  const h = harness(t);
  const result = await h.call({
    modelId: "Claude-Opus-4-6",
    providerId: "provider-1",
    vendorKey: "anthropic",
  });
  assert.ok(result.info, "a published id must return its record");
  assert.equal(result.info.modelId, "claude-opus-4-6");
  assert.equal(result.info.providerId, "provider-1");
  assert.equal(result.info.contextWindow, 1_000_000);
  assert.equal(result.info.maxTokens, 128_000);
  for (const level of ["low", "medium", "high"]) {
    assert.ok(result.info.supportedThinkingLevels.includes(level));
  }
  assert.ok(h.ensureLoaded.mock.callCount() > 0);
  assert.deepEqual(h.publishedModelFor.mock.calls[0].arguments, [{
    providerId: "provider-1",
    vendorKey: "anthropic",
    baseUrl: undefined,
    modelId: "Claude-Opus-4-6",
  }]);
  assert.deepEqual(h.hostCalls, []);
});

test("an id the library does not publish answers null", async (t) => {
  const h = harness(t);
  const result = await h.call({ modelId: "not-in-the-library" });
  assert.deepEqual(result, { info: null });
  assert.ok(h.ensureLoaded.mock.callCount() > 0);
  assert.deepEqual(h.hostCalls, []);
});

test("a blank id answers null without loading or resolving", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.call({ modelId: "   " }), { info: null });
  assert.equal(h.ensureLoaded.mock.callCount(), 0);
  assert.equal(h.publishedModelFor.mock.callCount(), 0);
  assert.equal(h.findModel.mock.callCount(), 0);
  assert.equal(h.settingsMetadataFor.mock.callCount(), 0);
  assert.deepEqual(h.hostCalls, []);
});

test("the catalog lookup never probes the provider or the host", async (t) => {
  const h = harness(t);
  const endpoint = { vendorKey: "custom", baseUrl: "https://provider.invalid/v1" };
  await h.call({ ...endpoint, modelId: "claude-opus-4.6" });
  await h.call({ ...endpoint, modelId: "missing" });
  assert.deepEqual(h.hostCalls, []);
});
