/**
 * Behavioural tests for the default-model summary line.
 *
 * `settings.defaultModelId` is a single global value while each provider owns
 * its own binding list, so the two can disagree. The summary line renders the
 * default provider's name and a model id side by side, which asserts a pairing
 * — these tests pin that the pairing shown is one that actually exists.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultModelIdOf,
  displayedDefaultModelId,
  providerOffersModel,
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
