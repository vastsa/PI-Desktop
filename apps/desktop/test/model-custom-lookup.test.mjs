/**
 * A hand-typed custom model id is seeded from the model library.
 *
 * Adding a custom id by hand used to give every binding the generic
 * 128,000 / 8,192 seed and no thinking levels, even when the library already
 * published that id. The picker now looks the id up and upgrades the row it
 * inserted. The rule is executed here rather than grepped for, because the
 * answer arrives asynchronously and must not overwrite an edit or a delete the
 * user made while it was in flight.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The workspace `node_modules` is shared with the primary checkout, whose
// `packages/shared/dist` predates this change. Resolve the package to this
// worktree's build, so the module under test uses the source being changed.
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@pi-desktop/shared") {
      return nextResolve(
        new URL("../../../packages/shared/dist/index.js", import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});
const { applyCustomModelLookup, customModelLookupInput, customModelSeedBinding } =
  await import("../src/components/settings/model-custom-lookup.ts");
resolution.deregister();

/** A published record as the host returns it from the local snapshot. */
const published = {
  modelId: "claude-opus-4.6",
  providerId: "",
  displayName: "Claude Opus 4.6",
  reasoning: true,
  supportedThinkingLevels: ["low", "medium", "high"],
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_000_000, output: 128_000 },
  capabilities: ["text", "vision"],
  source: "discovered",
};

test("a lookup hit seeds the row with the published limits and thinking levels", () => {
  const seed = customModelSeedBinding("Claude-Opus-4.6", null);
  // Before the answer: the generic seed.
  assert.equal(seed.contextWindow, 128_000);
  assert.equal(seed.maxTokens, 8_192);

  const next = applyCustomModelLookup([seed], seed, published);
  assert.equal(next.length, 1);
  assert.equal(next[0].contextWindow, 1_000_000);
  assert.equal(next[0].contextWindowSource, "catalog");
  assert.equal(next[0].maxTokens, 128_000);
  assert.deepEqual(next[0].thinkingLevels, ["low", "medium", "high"]);
});

test("the upgraded row keeps the id the user typed", () => {
  const seed = customModelSeedBinding("Claude-Opus-4.6", null);
  const [upgraded] = applyCustomModelLookup([seed], seed, published);
  assert.equal(upgraded.id, "Claude-Opus-4.6");
});

test("a miss keeps the generic seed and never drops the row", () => {
  const seed = customModelSeedBinding("not-published", null);
  const next = applyCustomModelLookup([seed], seed, null);
  assert.equal(next[0], seed);
  assert.equal(next[0].contextWindow, 128_000);
  assert.equal(next[0].maxTokens, 8_192);
  assert.deepEqual(next[0].thinkingLevels, []);
});

test("an edit made while the lookup was in flight is not overwritten", () => {
  const seed = customModelSeedBinding("Claude-Opus-4.6", null);
  const edited = { ...seed, contextWindow: 256_000, contextWindowSource: "user" };
  const next = applyCustomModelLookup([edited], seed, published);
  assert.equal(next[0], edited);
  assert.equal(next[0].contextWindow, 256_000);
});

test("a row removed while the lookup was in flight is not resurrected", () => {
  const seed = customModelSeedBinding("Claude-Opus-4.6", null);
  assert.deepEqual(applyCustomModelLookup([], seed, published), []);
});

test("a discovered row is used as-is instead of a second lookup", () => {
  // The current discovery already went through models.dev, so its record is
  // authoritative and its service-written id is the one to keep.
  const binding = customModelSeedBinding("whatever-case", published);
  assert.equal(binding.contextWindow, 1_000_000);
  assert.equal(binding.id, published.modelId);
});

test("the lookup input carries only the context this entry has", () => {
  assert.deepEqual(customModelLookupInput("m"), { modelId: "m" });
  assert.deepEqual(
    customModelLookupInput("m", {
      providerId: "p",
      vendorKey: "anthropic",
      baseUrl: "https://api.anthropic.com",
    }),
    {
      modelId: "m",
      providerId: "p",
      vendorKey: "anthropic",
      baseUrl: "https://api.anthropic.com",
    },
  );
  // An unsaved provider has no id and an untouched URL field is blank.
  assert.deepEqual(customModelLookupInput("m", { providerId: "", baseUrl: "" }), {
    modelId: "m",
  });
});
