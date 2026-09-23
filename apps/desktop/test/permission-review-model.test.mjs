import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { reviewThinkingLevels, selectedReviewThinkingLevel } = await import(
  "../src/features/settings/permission-review-model.ts"
);

const provider = {
  id: "provider",
  models: [
    { id: "reasoning", thinkingLevels: ["off", "low", "high"] },
    { id: "plain", thinkingLevels: ["off"] },
  ],
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
};

test("review thinking defaults to off without a fixed model", () => {
  assert.deepEqual(reviewThinkingLevels(provider, undefined, undefined), ["off"]);
  assert.equal(selectedReviewThinkingLevel(undefined, ["off", "low", "high"]), "off");
});

test("review thinking lists the selected model's configured levels only", () => {
  assert.deepEqual(reviewThinkingLevels(provider, "reasoning", undefined), ["off", "low", "high"]);
  assert.deepEqual(reviewThinkingLevels(provider, "plain", undefined), ["off"]);
  assert.equal(selectedReviewThinkingLevel("low", ["off", "low", "high"]), "low");
  assert.equal(selectedReviewThinkingLevel("low", ["off"]), "off");
});

test("review thinking keeps distinct complete model IDs separate", () => {
  const routed = {
    ...provider,
    models: [
      { id: "vendor/reasoning", thinkingLevels: ["low"] },
      { id: "reasoning", thinkingLevels: ["high"] },
    ],
  };
  assert.deepEqual(reviewThinkingLevels(routed, "vendor/reasoning", undefined), ["off", "low"]);
  assert.deepEqual(reviewThinkingLevels(routed, "reasoning", undefined), ["off", "high"]);
});
