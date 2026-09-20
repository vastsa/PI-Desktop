import assert from "node:assert/strict";
import test from "node:test";
import {
  dropPlacement,
  reorderItem,
  sameDropTarget,
  visibleNeighborMove,
} from "../src/lib/list-reorder.ts";

const ids = (models) => models.map((model) => model.id);
const models = [
  { id: "first", alias: "Fast", contextWindow: 128000, thinkingLevels: ["high"] },
  { id: "hidden", supportsImages: true },
  { id: "middle", maxTokens: 32000 },
  { id: "last", defaultThinkingLevel: "high", apiStyle: "responses" },
];

test("moves the first model to the end and the last to the beginning", () => {
  assert.deepEqual(ids(reorderItem(models, "first", "last", "after")), [
    "hidden", "middle", "last", "first",
  ]);
  assert.deepEqual(ids(reorderItem(models, "last", "first", "before")), [
    "last", "first", "hidden", "middle",
  ]);
});

test("inserts on either side of a target in both drag directions", () => {
  assert.deepEqual(ids(reorderItem(models, "first", "middle", "before")), [
    "hidden", "first", "middle", "last",
  ]);
  assert.deepEqual(ids(reorderItem(models, "last", "hidden", "after")), [
    "first", "hidden", "last", "middle",
  ]);
});

test("a filtered drag retains hidden models and every binding's overrides", () => {
  const next = reorderItem(models, "last", "first", "before");
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
    assert.equal(reorderItem(models, source, target, side), models);
  }
  assert.deepEqual(reorderItem([], "first", "last", "after"), []);
});

test("drop placement splits a row at its vertical midpoint", () => {
  assert.equal(dropPlacement(10, 0, 40), "before");
  assert.equal(dropPlacement(20, 0, 40), "before");
  assert.equal(dropPlacement(21, 0, 40), "after");
});

test("arrow keys move past the neighboring visible row and no-op at the ends", () => {
  const visible = [{ id: "shown-a" }, { id: "shown-b" }, { id: "shown-c" }];
  assert.deepEqual(visibleNeighborMove(visible, "shown-a", "down"), {
    targetId: "shown-b",
    placement: "after",
  });
  assert.deepEqual(visibleNeighborMove(visible, "shown-c", "up"), {
    targetId: "shown-b",
    placement: "before",
  });
  assert.equal(visibleNeighborMove(visible, "shown-a", "up"), null);
  assert.equal(visibleNeighborMove(visible, "shown-c", "down"), null);
  assert.equal(visibleNeighborMove(visible, "missing", "down"), null);
});

test("a filtered drag before the first visible row keeps hidden bindings in place", () => {
  const all = [
    { id: "shown-a" },
    { id: "hidden-a" },
    { id: "shown-b" },
    { id: "hidden-b" },
    { id: "shown-c" },
  ];
  const visible = all.filter((model) => model.id.startsWith("shown-"));
  const move = visibleNeighborMove(visible, "shown-c", "up");
  assert.deepEqual(move, { targetId: "shown-b", placement: "before" });
  assert.deepEqual(
    ids(reorderItem(all, "shown-c", "shown-a", "before")),
    ["shown-c", "shown-a", "hidden-a", "shown-b", "hidden-b"],
  );
  assert.deepEqual(
    ids(reorderItem(all, "shown-a", move.targetId, move.placement)),
    ["hidden-a", "shown-a", "shown-b", "hidden-b", "shown-c"],
  );
});

test("drop-target identity ignores equivalent previews", () => {
  const target = { id: "shown-a", placement: "before" };
  assert.equal(sameDropTarget(target, { id: "shown-a", placement: "before" }), true);
  assert.equal(sameDropTarget(target, { id: "shown-a", placement: "after" }), false);
  assert.equal(sameDropTarget(null, null), true);
  assert.equal(sameDropTarget(target, null), false);
});
