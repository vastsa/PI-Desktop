/**
 * Behavioural tests for the default-model summary line.
 *
 * `settings.defaultModelId` is a single global value while each provider owns
 * its own binding list, so the two can disagree. The summary line renders the
 * default provider's name and a model id side by side, which asserts a pairing
 * — these tests pin that the pairing shown is one that actually exists, and
 * that adding a provider only claims the default while none resolves.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultModelIdOf,
  displayedDefaultModelId,
  keepsAppDefaultModel,
  providerOffersModel,
  providerServesChatModels,
  hasResolvedDefaultModel,
} from "../src/components/settings/default-model.ts";

/** Minimal provider row; only the fields these resolvers read. */
const provider = (over = {}) => ({
  id: "p1",
  name: "Provider One",
  enabled: true,
  hasSecret: true,
  hasOauth: false,
  authKind: "api_key_and_base_url",
  models: [],
  ...over,
});

const binding = (id) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
});

test("a provider's own default is the head of its binding list", () => {
  const p = provider({ models: [binding("gpt-5"), binding("gpt-5-mini")] });
  assert.equal(defaultModelIdOf(p), "gpt-5");
});

test("a provider with no bindings falls back to its stored default id", () => {
  const p = provider({ models: [], defaultModelId: "claude-opus-4.6" });
  assert.equal(defaultModelIdOf(p), "claude-opus-4.6");
  // An OAuth row often looks exactly like this.
  assert.equal(providerOffersModel(p, "claude-opus-4.6"), true);
});

test("configured bindings outrank and constrain a stale legacy default", () => {
  const p = provider({
    models: [binding("gpt-5"), binding("")],
    defaultModelId: "claude-opus-4.6",
  });
  assert.equal(defaultModelIdOf(p), "gpt-5");
  assert.equal(providerOffersModel(p, "claude-opus-4.6"), false);
});

test("a global default belonging to another provider is not displayed", () => {
  // This was the bug: the row showed "Provider One · claude-opus-4.6" even
  // though Provider One only serves GPT models.
  const p = provider({ models: [binding("gpt-5"), binding("gpt-5-mini")] });
  assert.equal(providerOffersModel(p, "claude-opus-4.6"), false);
  assert.equal(displayedDefaultModelId(p, "claude-opus-4.6"), "gpt-5");
});

test("a global default the provider does serve is displayed as-is", () => {
  // Not necessarily the head binding: the user may have picked the second one.
  const p = provider({ models: [binding("gpt-5"), binding("gpt-5-mini")] });
  assert.equal(displayedDefaultModelId(p, "gpt-5-mini"), "gpt-5-mini");
});

test("model ids are matched tolerantly, not by raw equality", () => {
  // modelIdsMatch accepts the vendor-prefixed and region-suffixed spellings of
  // the same published model, so these must not be treated as a mismatch.
  const prefixed = provider({ models: [binding("openai/gpt-5")] });
  assert.equal(displayedDefaultModelId(prefixed, "gpt-5"), "gpt-5");
  const regional = provider({ models: [binding("claude-opus-4.6")] });
  assert.equal(
    displayedDefaultModelId(regional, "claude-opus-4.6@us-east"),
    "claude-opus-4.6@us-east",
  );
});

test("an empty or missing global default falls back to the provider", () => {
  const p = provider({ models: [binding("gpt-5")] });
  assert.equal(displayedDefaultModelId(p, undefined), "gpt-5");
  assert.equal(displayedDefaultModelId(p, ""), "gpt-5");
  assert.equal(providerOffersModel(p, ""), false);
});

test("a provider with nothing configured resolves to undefined", () => {
  // The caller renders settings.noModel rather than an empty gap.
  const p = provider({ models: [], defaultModelId: undefined });
  assert.equal(defaultModelIdOf(p), undefined);
  assert.equal(displayedDefaultModelId(p, "gpt-5"), undefined);
});

/**
 * Adding a provider must not steal a default the user already runs. The guard
 * resolves the stored value exactly the way the summary line does, so a stale
 * id left behind by a deleted provider still lets the new provider take over.
 */
test("a default that still resolves is kept when another provider is added", () => {
  const p = provider({ models: [binding("gpt-5"), binding("gpt-5-mini")] });
  assert.equal(hasResolvedDefaultModel([p], "p1", "gpt-5-mini"), true);
});

test("the default provider's own models count as a configured default", () => {
  // `defaultModelId` can be empty while the default provider already serves
  // models: the summary line shows that pairing, so a second provider must not
  // replace what the user is running.
  const p = provider({ models: [binding("gpt-5")] });
  assert.equal(hasResolvedDefaultModel([p], "p1", ""), true);
  assert.equal(hasResolvedDefaultModel([p], "p1", undefined), true);
});

test("a default whose provider is gone does not block a newly added one", () => {
  const p = provider({ models: [binding("gpt-5")] });
  assert.equal(hasResolvedDefaultModel([p], "deleted-provider", "gpt-5"), false);
  assert.equal(hasResolvedDefaultModel([p], undefined, "gpt-5"), false);
  assert.equal(hasResolvedDefaultModel([p], "", "gpt-5"), false);
});

test("an empty default resolves to nothing, so the new provider claims it", () => {
  const empty = provider({ models: [], defaultModelId: undefined });
  assert.equal(hasResolvedDefaultModel([empty], "p1", ""), false);
  // A stored id the default provider does not serve is not a default either:
  // the row renders the empty state, so the next provider may fill it.
  assert.equal(hasResolvedDefaultModel([empty], "p1", "gpt-5"), false);
});

/**
 * Which provider owns the app default after a new one is added.
 *
 * `hasResolvedDefaultModel` only asks whether the default provider still
 * *names* a model — a disabled or credential-less row does — so on its own it
 * keeps a default whose every launch dies with `PROVIDER_SECRET_MISSING` while
 * the provider the user just configured is never used. `keepsAppDefaultModel`
 * adds the readiness the picker already demands. The branch below mirrors the
 * add-provider branch of `ModelConfigPage.afterSaved`.
 */
const addProvider = (providers, settings, saved) => {
  const firstModelId = saved.models[0]?.id;
  if (!keepsAppDefaultModel(
    providers,
    settings.defaultProviderId,
    settings.defaultModelId,
    settings.imageGenerationModels,
  )) {
    return { ...settings, defaultProviderId: saved.id, defaultModelId: firstModelId ?? "" };
  }
  return settings;
};
test("a runnable default provider keeps the app default when one is added", () => {
  const current = provider({ models: [binding("gpt-5"), binding("gpt-5-mini")] });
  const added = provider({ id: "p2", name: "Provider Two", models: [binding("llama-4")] });
  const settings = { defaultProviderId: "p1", defaultModelId: "gpt-5-mini" };
  assert.equal(keepsAppDefaultModel([current], "p1", "gpt-5-mini"), true);
  assert.deepEqual(addProvider([current], settings, added), {
    defaultProviderId: "p1",
    defaultModelId: "gpt-5-mini",
  });
});
test("a default provider without a usable key lets the new provider take over", () => {
  // The real user path: the key was removed (or never entered) while
  // `defaultProviderId` kept pointing at the row, so the next session failed.
  const starved = provider({
    models: [binding("gpt-5"), binding("gpt-5-mini")],
    hasSecret: false,
    hasOauth: false,
  });
  const added = provider({ id: "p2", name: "Provider Two", models: [binding("llama-4")] });
  const settings = { defaultProviderId: "p1", defaultModelId: "gpt-5-mini" };
  // The old guard asked only this and answered yes, which was the regression.
  assert.equal(hasResolvedDefaultModel([starved], "p1", "gpt-5-mini"), true);
  assert.equal(keepsAppDefaultModel([starved], "p1", "gpt-5-mini"), false);
  assert.deepEqual(addProvider([starved], settings, added), {
    defaultProviderId: "p2",
    defaultModelId: "llama-4",
  });
});

test("a disabled default provider lets the new provider take over", () => {
  const off = provider({ models: [binding("gpt-5")], enabled: false });
  const added = provider({ id: "p2", name: "Provider Two", models: [binding("llama-4")] });
  assert.equal(keepsAppDefaultModel([off], "p1", "gpt-5"), false);
  assert.equal(
    addProvider([off], { defaultProviderId: "p1", defaultModelId: "gpt-5" }, added)
      .defaultProviderId,
    "p2",
  );
});

test("a default provider with nothing left to run lets the new provider take over", () => {
  // Either no chat model at all, or only the image model the default picker
  // excludes: both leave the default provider unable to run anything.
  const bare = provider({ models: [], defaultModelId: undefined });
  const imageOnly = provider({ models: [binding("gpt-image-1")] });
  const added = provider({ id: "p2", name: "Provider Two", models: [binding("llama-4")] });
  assert.equal(providerServesChatModels(bare), false);
  assert.equal(keepsAppDefaultModel([bare], "p1", ""), false);
  assert.equal(
    keepsAppDefaultModel([imageOnly], "p1", "gpt-image-1", {
      providerId: "p1",
      modelId: "gpt-image-1",
    }),
    false,
  );
  assert.equal(
    addProvider([bare], { defaultProviderId: "p1", defaultModelId: "" }, added)
      .defaultProviderId,
    "p2",
  );
});

test("a vendor-login default provider still holds the default", () => {
  // OAuth is a valid chat credential even though image generation refuses it,
  // so the add guard must not turn this into a stolen default.
  const vendor = provider({
    models: [binding("claude-opus-4.6")],
    authKind: "oauth",
    hasSecret: true,
    hasOauth: true,
  });
  assert.equal(providerServesChatModels(vendor), true);
  assert.equal(keepsAppDefaultModel([vendor], "p1", "claude-opus-4.6"), true);
});

test("a default provider that is gone still lets the new provider take over", () => {
  const added = provider({ id: "p2", name: "Provider Two", models: [binding("llama-4")] });
  assert.equal(keepsAppDefaultModel([added], "deleted-provider", "gpt-5"), false);
  assert.equal(
    addProvider([added], { defaultProviderId: "deleted-provider", defaultModelId: "gpt-5" }, added)
      .defaultProviderId,
    "p2",
  );
});
