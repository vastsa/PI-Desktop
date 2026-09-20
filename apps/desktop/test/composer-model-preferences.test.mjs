import assert from "node:assert/strict";
import { register } from "node:module";
import test, { beforeEach } from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  COMPOSER_MODEL_PREFERENCES_KEY: key,
  rememberComposerModel,
  rememberedComposerThinking,
  newSessionModelConfiguration,
} = await import("../src/lib/composer-model-preferences.ts");
const values = new Map();
beforeEach(() => {
  values.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
});
const providers = ["a", "b"].map((id) => ({
  id,
  enabled: true,
  authKind: "none",
  models: [
    {
      id: "one",
      thinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
    },
    { id: "two", thinkingLevels: ["off"] },
  ],
}));
const settings = { defaultProviderId: "a", defaultModelId: "one" };
const resolve = (extra = {}) =>
  newSessionModelConfiguration({ providers, settings, ...extra });
const remember = (providerId, modelId, thinkingLevel) =>
  rememberComposerModel({ providerId, modelId, thinkingLevel });

test("fresh profiles keep Settings defaults; explicit choices survive subsequent reads", () => {
  assert.deepEqual(resolve(), {
    providerId: "a",
    modelId: "one",
    thinkingLevel: "high",
  });
  remember("b", "one", "low");
  assert.deepEqual(resolve(), {
    providerId: "b",
    modelId: "one",
    thinkingLevel: "low",
  });
  assert.deepEqual(JSON.parse(values.get(key)), [
    { providerId: "b", modelId: "one", thinkingLevel: "low" },
  ]);
  assert.equal(settings.defaultProviderId, "a");
});

test("thinking is isolated by provider and model, including omit", () => {
  remember("a", "one", "low");
  remember("b", "one", "omit");
  remember("a", "two", "off");
  assert.equal(rememberedComposerThinking(providers[0], "one"), "low");
  assert.equal(rememberedComposerThinking(providers[1], "one"), "omit");
  assert.equal(rememberedComposerThinking(providers[0], "two"), "off");
});

test("removed, disabled and unauthenticated choices fall back to Settings, not older choices", () => {
  remember("a", "two", "off");
  remember("b", "one", "low");
  for (const unavailable of [
    null,
    { ...providers[1], enabled: false },
    { ...providers[1], models: [], defaultModelId: undefined },
    { ...providers[1], authKind: "api-key", hasSecret: false },
  ]) {
    assert.equal(
      resolve({
        providers: [providers[0], ...(unavailable ? [unavailable] : [])],
      }).modelId,
      "one",
    );
    assert.equal(
      resolve({
        providers: [providers[0], ...(unavailable ? [unavailable] : [])],
      }).providerId,
      "a",
    );
  }
});

test("draft wins while permissions and operating mode never enter the preference", () => {
  rememberComposerModel({
    providerId: "b",
    modelId: "one",
    thinkingLevel: "low",
    permissionMode: "auto",
    mode: "goal",
  });
  assert.deepEqual(
    resolve({
      draft: { providerId: "a", modelId: "two", thinkingLevel: "off" },
    }),
    { providerId: "a", modelId: "two", thinkingLevel: "off" },
  );
  assert.equal(values.get(key).includes("auto"), false);
  assert.equal(values.get(key).includes("goal"), false);
});

test("changed capabilities clamp saved thinking and never send omit to a non-reasoning model", () => {
  remember("a", "one", "low");
  const changed = {
    ...providers[0],
    models: [{ id: "one", thinkingLevels: ["high"] }],
  };
  assert.equal(rememberedComposerThinking(changed, "one"), "high");
  remember("a", "one", "omit");
  assert.equal(
    rememberedComposerThinking(
      { ...changed, models: [{ id: "one", thinkingLevels: ["off"] }] },
      "one",
    ),
    "off",
  );
});

test("invalid data and unavailable storage degrade to defaults without blocking", () => {
  for (const raw of [
    "{",
    "null",
    "{}",
    '[{"providerId":"b","modelId":"one","thinkingLevel":"invalid"}]',
  ]) {
    values.set(key, raw);
    assert.equal(resolve().providerId, "a");
  }
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  assert.doesNotThrow(() => remember("b", "one", "low"));
  assert.equal(resolve().providerId, "a");
});

test("history stays bounded and repeated selections replace the matching entry", () => {
  for (let index = 0; index < 105; index += 1)
    remember("a", `model-${index}`, "low");
  remember("a", "model-104", "high");
  const saved = JSON.parse(values.get(key));
  assert.equal(saved.length, 100);
  assert.equal(saved[0].thinkingLevel, "high");
  assert.equal(
    saved.filter((entry) => entry.modelId === "model-104").length,
    1,
  );
});
