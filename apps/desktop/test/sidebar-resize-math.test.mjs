import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "../src/lib/sidebar-preferences.ts";
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_RESIZE_STEP,
  sidebarPointerResize,
  sidebarResetWidth,
  sidebarWidthBudget,
} from "../src/lib/sidebar-resize.ts";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from "../src/lib/work-panel-resize.ts";

test("pointer resize clamps to the expanded range and collapses below the snap threshold", () => {
  assert.equal(SIDEBAR_COLLAPSE_THRESHOLD, 160);
  assert.equal(SIDEBAR_RESIZE_STEP, 16);
  assert.deepEqual(
    sidebarPointerResize({ startWidth: 275, deltaX: 0 }),
    { type: "width", width: 275 },
  );
  assert.deepEqual(
    sidebarPointerResize({ startWidth: 275, deltaX: 37.6 }),
    { type: "width", width: 313 },
  );
  assert.deepEqual(
    sidebarPointerResize({ startWidth: 275, deltaX: -40 }),
    { type: "width", width: SIDEBAR_WIDTH_MIN },
  );
  assert.deepEqual(
    sidebarPointerResize({ startWidth: 275, deltaX: 400 }),
    { type: "width", width: SIDEBAR_WIDTH_MAX },
  );
  assert.deepEqual(
    sidebarPointerResize({ startWidth: 275, deltaX: 160, maxWidth: 300 }),
    { type: "width", width: 300 },
  );
  assert.deepEqual(
    sidebarPointerResize({
      startWidth: 275,
      deltaX: SIDEBAR_COLLAPSE_THRESHOLD - 275 - 1,
    }),
    { type: "collapse" },
  );
  assert.deepEqual(
    sidebarPointerResize({
      startWidth: 275,
      deltaX: SIDEBAR_COLLAPSE_THRESHOLD - 275,
    }),
    { type: "width", width: SIDEBAR_WIDTH_MIN },
  );
});

test("the live sidebar budget keeps MainChat above its floor", () => {
  assert.equal(
    sidebarWidthBudget({
      containerWidth: 1040,
      workPanelOpen: false,
      workPanelWidth: 360,
    }),
    SIDEBAR_WIDTH_MAX,
  );
  assert.equal(
    sidebarWidthBudget({
      containerWidth: 1200,
      workPanelOpen: true,
      workPanelWidth: 360,
    }),
    389,
  );
  assert.equal(
    sidebarWidthBudget({
      containerWidth: 1040,
      workPanelOpen: true,
      workPanelWidth: 360,
    }),
    SIDEBAR_WIDTH_MIN,
  );
  assert.equal(
    sidebarWidthBudget({
      containerWidth: 1200,
      workPanelOpen: true,
      workPanelWidth: 360,
      workPanelMaximized: true,
    }),
    SIDEBAR_WIDTH_MAX,
  );
  assert.equal(
    sidebarWidthBudget({
      containerWidth: 600,
      workPanelOpen: false,
      workPanelWidth: 0,
      workPanelMaximized: true,
    }),
    Math.max(SIDEBAR_WIDTH_MIN, 600 - WORK_PANEL_MIN_WIDTH),
  );
  const capped = sidebarWidthBudget({
    containerWidth: 1200,
    workPanelOpen: true,
    workPanelWidth: 360,
  });
  assert.equal(1200 - capped - 360, MAIN_PANE_MIN_WIDTH + 1);
  assert.equal(SIDEBAR_WIDTH_DEFAULT, 275);
});

test("double-click resets the sidebar to its default inside the live budget", () => {
  assert.equal(sidebarResetWidth(), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(sidebarResetWidth(SIDEBAR_WIDTH_MAX), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(sidebarResetWidth(300), SIDEBAR_WIDTH_DEFAULT);
  // A squeezed three-column window keeps its cap, so the reset can never push
  // MainChat under its 450px floor.
  assert.equal(sidebarResetWidth(250), 250);
  assert.equal(sidebarResetWidth(SIDEBAR_WIDTH_MIN - 100), SIDEBAR_WIDTH_MIN);
});
