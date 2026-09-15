import assert from "node:assert/strict";
import test from "node:test";
import { reorderModel } from "../src/components/settings/model-reorder.ts";

const ids = (models) => models.map((model) => model.id);
const models = [
  { id: "first", alias: "Fast", contextWindow: 128000, thinkingLevels: ["high"] },
  { id: "hidden", supportsImages: true },
  { id: "middle", maxTokens: 32000 },
  { id: "last", defaultThinkingLevel: "high", apiStyle: "responses" },
];

test("moves the first model to the end and the last to the beginning", () => {
  assert.deepEqual(ids(reorderModel(models, "first", "last", "after")), [
    "hidden", "middle", "last", "first",
  ]);
  assert.deepEqual(ids(reorderModel(models, "last", "first", "before")), [
    "last", "first", "hidden", "middle",
  ]);
});

test("inserts on either side of a target in both drag directions", () => {
  assert.deepEqual(ids(reorderModel(models, "first", "middle", "before")), [
    "hidden", "first", "middle", "last",
  ]);
  assert.deepEqual(ids(reorderModel(models, "last", "hidden", "after")), [
    "first", "hidden", "last", "middle",
  ]);
});

test("a filtered drag retains hidden models and every binding's overrides", () => {
  const next = reorderModel(models, "last", "first", "before");
  assert.deepEqual(ids(next), ["last", "first", "hidden", "middle"]);
  for (const binding of models) {
    assert.equal(next.find((model) => model.id === binding.id), binding);
  }
  assert.deepEqual(ids(models), ["first", "hidden", "middle", "last"]);
});

test("same-place drops and stale or missing targets leave the draft unchanged", () => {
  for (const [source, target, side] of [
    ["first", "first", "after"],
    ["first", "hidden", "before"],
    ["hidden", "first", "after"],
    ["removed", "first", "before"],
    ["first", "removed", "after"],
  ]) {
    assert.equal(reorderModel(models, source, target, side), models);
  }
  assert.deepEqual(reorderModel([], "first", "last", "after"), []);
});
