import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_REORDER_ARM_PX,
  projectGroupKeyFromPoint,
  projectPinZoneFromPoint,
  projectPinZoneOf,
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

test("a project belongs to the zone its pin state puts it in", () => {
  assert.equal(projectPinZoneOf({}), "rest");
  assert.equal(projectPinZoneOf({ pinned: false }), "rest");
  assert.equal(projectPinZoneOf({ pinned: true }), "pinned");
});

test("pin-zone hit-testing reads the half of the list under the pointer", () => {
  // Crossing buckets cannot be decided from a row, because the half being
  // entered may hold no rows at all — so the zone is carried by the list
  // containers and is found from whatever is under the pointer, including the
  // label and the padding around it.
  const zone = (value) => ({
    getAttribute(name) {
      return name === "data-sidebar-project-pin-zone" ? value : null;
    },
  });
  const leafOver = (value) => ({
    closest(selector) {
      return selector === "[data-sidebar-project-pin-zone]" ? zone(value) : null;
    },
  });
  const doc = {
    elementFromPoint(x) {
      if (x === 10) return leafOver("pinned");
      if (x === 20) return leafOver("rest");
      return null;
    },
  };
  assert.equal(projectPinZoneFromPoint(10, 0, doc), "pinned");
  assert.equal(projectPinZoneFromPoint(20, 0, doc), "rest");
  // Off the list entirely: no zone, so no pin or unpin is offered.
  assert.equal(projectPinZoneFromPoint(30, 0, doc), null);
});

test("an unrecognised zone attribute is not treated as a drop target", () => {
  const doc = {
    elementFromPoint() {
      return {
        closest: () => ({
          getAttribute: () => "somewhere-else",
        }),
      };
    },
  };
  assert.equal(projectPinZoneFromPoint(0, 0, doc), null);
});
