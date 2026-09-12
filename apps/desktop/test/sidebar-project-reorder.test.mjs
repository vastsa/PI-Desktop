import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_REORDER_ARM_PX,
  projectGroupKeyFromPoint,
  projectReorderInsertAfter,
  projectReorderShouldArm,
  sameProjectReorderBucket,
} from "../src/lib/sidebar-project-reorder.ts";

test("project title reorder arms after a small pointer movement, not a time delay", () => {
  assert.equal(PROJECT_REORDER_ARM_PX, 8);
  assert.equal(projectReorderShouldArm(0, 0), false);
  assert.equal(projectReorderShouldArm(4, 4), false);
  assert.equal(projectReorderShouldArm(8, 0), false);
  assert.equal(projectReorderShouldArm(9, 0), true);
  assert.equal(projectReorderShouldArm(0, 9), true);
});

test("drop inserts after the target when the pointer is in the lower half", () => {
  assert.equal(projectReorderInsertAfter(10, 0, 40), false);
  assert.equal(projectReorderInsertAfter(20, 0, 40), false);
  assert.equal(projectReorderInsertAfter(21, 0, 40), true);
});

test("reorder stays inside the same pinned or archived bucket", () => {
  assert.equal(sameProjectReorderBucket({}, {}), true);
  assert.equal(sameProjectReorderBucket({ pinned: true }, { pinned: true }), true);
  assert.equal(sameProjectReorderBucket({ pinned: true }, { pinned: false }), false);
  assert.equal(
    sameProjectReorderBucket({ archived: true }, { archived: true }),
    true,
  );
  assert.equal(
    sameProjectReorderBucket({ archived: true }, { archived: false }),
    false,
  );
});

test("project group hit-testing reads the nearest group under the pointer", () => {
  const group = {
    getAttribute(name) {
      return name === "data-sidebar-project-group" ? "/tmp/demo" : null;
    },
    getBoundingClientRect() {
      return { top: 10, height: 40 };
    },
  };
  const leaf = {
    closest(selector) {
      return selector === "[data-sidebar-project-group]" ? group : null;
    },
  };
  const doc = {
    elementFromPoint(x, y) {
      return x === 12 && y === 24 ? leaf : null;
    },
  };
  assert.deepEqual(projectGroupKeyFromPoint(12, 24, doc), {
    key: "/tmp/demo",
    top: 10,
    height: 40,
  });
  assert.equal(projectGroupKeyFromPoint(0, 0, doc), null);
});
