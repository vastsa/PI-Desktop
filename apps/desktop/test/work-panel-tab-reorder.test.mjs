import assert from "node:assert/strict";
import test from "node:test";

const {
  WORK_PANEL_TAB_REORDER_EDGE_PX,
  WORK_PANEL_TAB_REORDER_ARM_PX,
  WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX,
  workPanelTabReorderInsertAfter,
  workPanelTabReorderShouldArm,
  workPanelTabReorderScrollDelta,
} = await import("../src/lib/work-panel-tab-reorder.ts");

test("tab reorder arms only after the pointer crosses the movement threshold", () => {
  assert.equal(workPanelTabReorderShouldArm(4, 5), false);
  assert.equal(
    workPanelTabReorderShouldArm(WORK_PANEL_TAB_REORDER_ARM_PX + 1, 0),
    true,
  );
});

test("tab reorder inserts after the target's horizontal midpoint", () => {
  assert.equal(workPanelTabReorderInsertAfter(99, 50, 100), false);
  assert.equal(workPanelTabReorderInsertAfter(101, 50, 100), true);
});

test("tab reorder scrolls toward the edge with a bounded speed", () => {
  assert.equal(workPanelTabReorderScrollDelta(200, 100, 300), 0);
  assert.equal(
    workPanelTabReorderScrollDelta(100, 100, 300),
    -WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX,
  );
  assert.equal(
    workPanelTabReorderScrollDelta(300, 100, 300),
    WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX,
  );
  assert.equal(
    workPanelTabReorderScrollDelta(
      100 + WORK_PANEL_TAB_REORDER_EDGE_PX / 2,
      100,
      300,
    ),
    -WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX / 2,
  );
  assert.equal(workPanelTabReorderScrollDelta(0, 100, 300), -WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX);
  assert.equal(workPanelTabReorderScrollDelta(400, 100, 300), WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX);
});
