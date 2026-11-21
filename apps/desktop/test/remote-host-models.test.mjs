/**
 * The Host's model catalog and context usage cross a machine and a release
 * boundary, so the renderer receives only what already matched the RACP shape,
 * and the mapping onto local UI types must not invent capability the Host did
 * not declare.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { validateModelCatalog, validateSessionUsage } = await import(
  "../electron/main/remote/remote-host-models.ts"
);
const {
  EMPTY_REMOTE_MODEL_CATALOG,
  remoteContextWindow,
  remoteModelCatalog,
} = await import("../src/lib/remote-host-models.ts");

const model = (overrides = {}) => ({
  providerId: "p1",
  providerName: "Host provider",
  modelId: "m1",
  displayName: "Model One",
  ...overrides,
});

test("validateModelCatalog normalizes a well-formed Host catalog", () => {
  const catalog = validateModelCatalog({
    models: [
      model({ contextWindow: 200_000, capabilities: ["text", "tools"], supportedThinkingLevels: ["low", "high"] }),
      model({ providerId: "p2", providerName: "Other", modelId: "m2", displayName: undefined, fastMode: true }),
    ],
    defaultProviderId: "p1",
    defaultModelId: "m1",
  });
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].contextWindow, 200_000);
  assert.deepEqual(catalog.models[0].supportedThinkingLevels, ["low", "high"]);
  assert.equal(catalog.models[1].fastMode, true);
  assert.equal(catalog.models[1].displayName, "m2");
  assert.equal(catalog.models[1].providerName, "Other");
  assert.equal(catalog.defaultProviderId, "p1");
  assert.equal(catalog.defaultModelId, "m1");
});

test("validateModelCatalog rejects payloads that are not a catalog", () => {
  for (const payload of [null, "models", [], { models: "m1" }, { models: [model({ providerId: "" })] }]) {
    assert.throws(() => validateModelCatalog(payload), { errorCode: "INVALID_ARGUMENT" });
  }
  // A measurement must be a measurement: negative, fractional and absurd
  // windows are refused rather than painted as a context ring.
  for (const contextWindow of [0, -1, 1.5, 20_000_000]) {
    assert.throws(() => validateModelCatalog({ models: [model({ contextWindow })] }), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  assert.throws(
    () => validateModelCatalog({ models: [model({ displayName: "bad\u0000name" })] }),
    { errorCode: "INVALID_ARGUMENT" },
  );
});

test("validateSessionUsage keeps counts and drops absent optional fields", () => {
  const usage = validateSessionUsage({
    usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 0 },
    providerId: "p1",
    modelId: "m1",
    contextWindow: 128_000,
    updatedAt: "2026-10-10T00:00:00Z",
  });
  assert.deepEqual(usage.usage, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
  assert.equal(usage.contextWindow, 128_000);
  assert.equal(usage.modelId, "m1");

  // No request has reported yet: the shape stays valid and empty.
  assert.deepEqual(validateSessionUsage({}), {});
});

test("validateSessionUsage rejects impossible counts", () => {
  for (const usage of [
    { inputTokens: -1 },
    { outputTokens: 1.5 },
    { totalTokens: "100" },
  ]) {
    assert.throws(() => validateSessionUsage({ usage }), { errorCode: "INVALID_ARGUMENT" });
  }
  assert.throws(() => validateSessionUsage({ contextWindow: 0 }), { errorCode: "INVALID_ARGUMENT" });
  assert.throws(() => validateSessionUsage(null), { errorCode: "INVALID_ARGUMENT" });
});

test("remoteModelCatalog groups the flat Host rows by provider, in Host order", () => {
  const catalog = remoteModelCatalog({
    models: [
      model({ providerId: "p1", modelId: "a", displayName: "A" }),
      model({ providerId: "p2", providerName: "Second", modelId: "b", displayName: "B" }),
      model({ providerId: "p1", modelId: "c", displayName: "C" }),
    ],
  });
  assert.deepEqual(catalog.providers.map((provider) => provider.id), ["p1", "p2"]);
  assert.deepEqual(catalog.providerModels.p1.map((info) => info.modelId), ["a", "c"]);
  assert.deepEqual(catalog.providerModels.p2.map((info) => info.modelId), ["b"]);
  assert.equal(catalog.providers[0].name, "Host provider");
  assert.equal(catalog.providers[0].defaultModelId, "a");
});

test("remoteModelCatalog keeps the Host's declared thinking ladder", () => {
  const catalog = remoteModelCatalog({
    models: [
      model({ modelId: "reasoner", supportedThinkingLevels: ["high", "low"] }),
      model({ providerId: "p2", modelId: "plain" }),
    ],
  });
  // Ladder order is canonical, not the Host's array order.
  assert.deepEqual(catalog.providers[0].supportedThinkingLevels, ["low", "high"]);
  assert.equal(catalog.providers[0].supportsReasoning, true);
  // A model with no declared ladder gains none: the reasoning control stays off.
  assert.deepEqual(catalog.providerModels.p2[0].supportedThinkingLevels, undefined);
  assert.equal(catalog.providers[1].supportsReasoning, false);
});

test("remoteModelCatalog is empty for an absent or empty Host catalog", () => {
  assert.equal(remoteModelCatalog(undefined), EMPTY_REMOTE_MODEL_CATALOG);
  assert.equal(remoteModelCatalog({ models: [] }), EMPTY_REMOTE_MODEL_CATALOG);
});

test("remoteContextWindow only returns a usable window", () => {
  assert.equal(remoteContextWindow({ contextWindow: 200_000 }), 200_000);
  assert.equal(remoteContextWindow({}), undefined);
  assert.equal(remoteContextWindow(undefined), undefined);
});