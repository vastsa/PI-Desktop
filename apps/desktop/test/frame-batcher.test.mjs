import assert from "node:assert/strict";
import test from "node:test";
import { createFrameBatcher } from "../src/lib/frame-batcher.ts";

test("frame batcher keeps the latest value for each stream target", () => {
  const batches = [];
  const batcher = createFrameBatcher((values) => {
    batches.push([...values]);
  });

  batcher.enqueue("message:a", "first");
  batcher.enqueue("message:a", "latest");
  batcher.enqueue("tool:b", "tool");
  assert.equal(batches.length, 0);

  batcher.flushNow();

  assert.deepEqual(batches, [["latest", "tool"]]);
  assert.equal(batcher.size, 0);
});

test("frame batcher flushes immediately without leaving a timer", () => {
  const batches = [];
  const batcher = createFrameBatcher((values) => batches.push([...values]));

  batcher.enqueue("message:a", 1);
  batcher.flushNow();
  batcher.flushNow();

  assert.deepEqual(batches, [[1]]);
  assert.equal(batcher.size, 0);
});
