import assert from "node:assert/strict";
import test from "node:test";
import { transcriptReaderMovement } from "../src/lib/transcript-reading-anchor.ts";

test("a mandatory shrink clamp is not reader displacement", () => {
  assert.equal(transcriptReaderMovement(800, 500, 1000, 500), 0);
  assert.equal(transcriptReaderMovement(800, 800, 1400, 500), 0);
});
test("reader movement in the clamped layout is still applied", () => {
  assert.equal(transcriptReaderMovement(800, 450, 1000, 500), -50);
  assert.equal(transcriptReaderMovement(500, 540, 1500, 500), 40);
});
test("viewport growth, underfill and fractional offsets retain legal geometry", () => {
  assert.equal(transcriptReaderMovement(800, 500, 1500, 1000), 0);
  assert.equal(transcriptReaderMovement(200, 0, 400, 500), 0);
  assert.equal(transcriptReaderMovement(800.25, 450.125, 1000, 500), -49.875);
});
test("own compensation is rebased before its queued scroll event", () => {
  assert.equal(transcriptReaderMovement(300, 300, 1000, 500), 0);
  assert.equal(transcriptReaderMovement(300, 260, 1000, 500), -40);
});
