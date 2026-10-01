import test from "node:test";
import assert from "node:assert/strict";
import { scaleBoundsToDip } from "../electron/main/plugin-view-bounds.ts";

test("scaleBoundsToDip leaves a 100% zoom rect unchanged", () => {
  assert.deepEqual(
    scaleBoundsToDip({ x: 10, y: 20, width: 300, height: 200 }, 1),
    { x: 10, y: 20, width: 300, height: 200 },
  );
});

test("scaleBoundsToDip multiplies CSS pixels by zoomFactor", () => {
  // At 90% zoom a CSS x of 1333 maps to DIP 1200 — matching the ~148px
  // right-shift reported in #980 when CSS pixels were passed through.
  assert.deepEqual(
    scaleBoundsToDip({ x: 1333, y: 40, width: 400, height: 800 }, 0.9),
    { x: 1200, y: 36, width: 360, height: 720 },
  );
});

test("scaleBoundsToDip multiplies out for zoom-in and clamps negatives", () => {
  assert.deepEqual(
    scaleBoundsToDip({ x: -5, y: 10, width: 100, height: 50 }, 1.25),
    { x: 0, y: 13, width: 125, height: 63 },
  );
});

test("scaleBoundsToDip treats invalid zoom as 1", () => {
  assert.deepEqual(
    scaleBoundsToDip({ x: 8, y: 8, width: 8, height: 8 }, 0),
    { x: 8, y: 8, width: 8, height: 8 },
  );
  assert.deepEqual(
    scaleBoundsToDip({ x: 8, y: 8, width: 8, height: 8 }, Number.NaN),
    { x: 8, y: 8, width: 8, height: 8 },
  );
});
