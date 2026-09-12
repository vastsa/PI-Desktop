import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_PANEL_CHAT_MAX_WIDTH,
  WORK_PANEL_CHAT_MIN_WIDTH,
  MAIN_PANE_MIN_WIDTH,
  MAIN_PANE_REOPEN_TARGET_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  clampWorkPanelChatWidth,
  clampWorkPanelWidth,
  committedWorkPanelChatWidth,
  parseWorkPanelChatWidth,
  workPanelLayout,
  workPanelChatWidthFromPointer,
  workPanelWidthForSidebarReopen,
} from "../src/lib/work-panel-resize.ts";

test("the three-column budget protects MainChat and collapses the sidebar at the threshold", () => {
  assert.equal(MAIN_PANE_MIN_WIDTH, 360);
  assert.equal(MAIN_PANE_REOPEN_TARGET_WIDTH, 370);
  const layout = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 720,
  });

  assert.equal(layout.maxPanelWidth, 405);
  assert.equal(layout.panelWidth, 405);
  assert.equal(layout.mainWidth, MAIN_PANE_MIN_WIDTH);
  assert.equal(layout.shouldCollapseSidebar, true);
});

test("the expanded sidebar collapses as soon as MainChat reaches 360px", () => {
  const justAbove = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 404,
  });
  const atFloor = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 405,
  });

  assert.equal(justAbove.mainWidth, 361);
  assert.equal(justAbove.shouldCollapseSidebar, false);
  assert.equal(atFloor.mainWidth, MAIN_PANE_MIN_WIDTH);
  assert.equal(atFloor.shouldCollapseSidebar, true);
});

test("a collapsed sidebar exposes the full dynamic right-column budget", () => {
  const layout = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: true,
    requestedPanelWidth: 720,
  });

  assert.equal(layout.maxPanelWidth, 680);
  assert.equal(layout.panelWidth, 680);
  assert.equal(layout.mainWidth, MAIN_PANE_MIN_WIDTH);
  assert.equal(layout.shouldCollapseSidebar, false);
});

test("sidebar reopen spends right-panel width before using the 370px target", () => {
  assert.equal(
    workPanelWidthForSidebarReopen({
      containerWidth: 1040,
      sidebarWidth: 275,
      currentPanelWidth: 600,
    }),
    395,
  );
  assert.equal(
    workPanelWidthForSidebarReopen({
      containerWidth: 1040,
      sidebarWidth: 520,
      currentPanelWidth: 360,
    }),
    150,
  );
  assert.equal(
    workPanelWidthForSidebarReopen({
      containerWidth: 2000,
      sidebarWidth: 275,
      currentPanelWidth: 360,
    }),
    360,
  );
});

test("the compact width stays representable for the reopen path", () => {
  assert.equal(
    workPanelWidthForSidebarReopen({
      containerWidth: 1040,
      sidebarWidth: 800,
      currentPanelWidth: WORK_PANEL_MIN_WIDTH,
    }),
    WORK_PANEL_COMPACT_MIN_WIDTH,
  );
  assert.equal(
    clampWorkPanelWidth(120, WORK_PANEL_COMPACT_MIN_WIDTH),
    120,
  );
  assert.equal(clampWorkPanelWidth(0, WORK_PANEL_COMPACT_MIN_WIDTH), WORK_PANEL_COMPACT_MIN_WIDTH);
});

test("clamps the work panel to its fixed width range", () => {
  assert.equal(clampWorkPanelWidth(900), WORK_PANEL_MAX_WIDTH);
  assert.equal(clampWorkPanelWidth(500), 500);
  assert.equal(clampWorkPanelWidth(200), WORK_PANEL_MIN_WIDTH);
});

test("clamps the conversation area to its bounded native resize range", () => {
  assert.equal(clampWorkPanelChatWidth(900), WORK_PANEL_CHAT_MIN_WIDTH);
  assert.equal(clampWorkPanelChatWidth(1200), 1200);
  assert.equal(clampWorkPanelChatWidth(20000), WORK_PANEL_CHAT_MAX_WIDTH);
});

test("anchors inner-divider resizing to the conversation width at gesture start", () => {
  const gesture = { startClientX: 800, startWidth: 1200 };

  assert.equal(workPanelChatWidthFromPointer(gesture, 800), 1200);
  assert.equal(workPanelChatWidthFromPointer(gesture, 880), 1280);
  assert.equal(workPanelChatWidthFromPointer(gesture, 720), 1120);
});

test("inner-divider resizing respects the conversation limits", () => {
  assert.equal(
    workPanelChatWidthFromPointer(
      { startClientX: 800, startWidth: WORK_PANEL_CHAT_MIN_WIDTH },
      300,
    ),
    WORK_PANEL_CHAT_MIN_WIDTH,
  );
  assert.equal(
    workPanelChatWidthFromPointer(
      { startClientX: 800, startWidth: WORK_PANEL_CHAT_MAX_WIDTH },
      1300,
    ),
    WORK_PANEL_CHAT_MAX_WIDTH,
  );
});

test("commits only a changed conversation preview after a completed gesture", () => {
  const gesture = { startClientX: 800, startWidth: WORK_PANEL_DEFAULT_WIDTH + 920 };

  assert.equal(
    committedWorkPanelChatWidth(gesture, gesture.startWidth, true),
    null,
  );
  assert.equal(committedWorkPanelChatWidth(gesture, 1400, false), null);
  assert.equal(committedWorkPanelChatWidth(gesture, 1400, true), 1400);
});

test("accepts only bounded integer conversation widths over IPC", () => {
  assert.equal(parseWorkPanelChatWidth({ width: 1040 }), 1040);
  assert.equal(parseWorkPanelChatWidth({ width: 10000 }), 10000);
  assert.equal(parseWorkPanelChatWidth({ width: 1039 }), null);
  assert.equal(parseWorkPanelChatWidth({ width: 10000.5 }), null);
  assert.equal(parseWorkPanelChatWidth({ width: "1200" }), null);
  assert.equal(parseWorkPanelChatWidth(null), null);
});
