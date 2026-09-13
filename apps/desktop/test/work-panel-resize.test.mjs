import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_PANEL_CHAT_MAX_WIDTH,
  WORK_PANEL_CHAT_MIN_WIDTH,
  MAIN_PANE_MIN_WIDTH,
  MAIN_PANE_REOPEN_TARGET_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_COMPACT_MIN_WIDTH,
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
  assert.equal(MAIN_PANE_MIN_WIDTH, 450);
  assert.equal(MAIN_PANE_REOPEN_TARGET_WIDTH, 460);
  const layout = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 720,
  });

  assert.equal(layout.maxPanelWidth, 315);
  assert.equal(layout.panelWidth, 315);
  assert.equal(layout.mainWidth, MAIN_PANE_MIN_WIDTH);
  assert.equal(layout.shouldCollapseSidebar, true);
});

test("the expanded sidebar collapses as soon as MainChat reaches 360px", () => {
  const justAbove = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 314,
  });
  const atFloor = workPanelLayout({
    containerWidth: 1040,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 315,
  });

  assert.equal(justAbove.mainWidth, 451);
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

  assert.equal(layout.maxPanelWidth, 590);
  assert.equal(layout.panelWidth, 590);
  assert.equal(layout.mainWidth, MAIN_PANE_MIN_WIDTH);
  assert.equal(layout.shouldCollapseSidebar, false);
});

test("sidebar reopen spends right-panel width before using the 460px target", () => {
  assert.equal(
    workPanelWidthForSidebarReopen({
      containerWidth: 1040,
      sidebarWidth: 275,
      currentPanelWidth: 600,
    }),
    305,
  );
  assert.equal(
    workPanelWidthForSidebarReopen({
      containerWidth: 1040,
      sidebarWidth: 520,
      currentPanelWidth: 360,
    }),
    60,
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

test("a wide window lets the panel grow past the old fixed cap", () => {
  // Regression guard: the panel maximum is the live budget, so a 1600px shell
  // must allow 875px (1600 - 275 sidebar - 450 floor) rather than stopping at
  // a fixed 720px cap.
  const wide = workPanelLayout({
    containerWidth: 1600,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 1200,
  });
  assert.equal(wide.maxPanelWidth, 875);
  assert.equal(wide.panelWidth, 875);
  assert.equal(wide.mainWidth, MAIN_PANE_MIN_WIDTH);
  assert.equal(wide.shouldCollapseSidebar, true);

  // The same window with the sidebar already yielded spends its width on the
  // panel down to the floor.
  const yielded = workPanelLayout({
    containerWidth: 1600,
    sidebarWidth: 275,
    sidebarCollapsed: true,
    requestedPanelWidth: 1500,
  });
  assert.equal(yielded.maxPanelWidth, 1150);
  assert.equal(yielded.panelWidth, 1150);
  assert.equal(yielded.mainWidth, MAIN_PANE_MIN_WIDTH);
});

test("preview mode gives the panel the whole client area beside the sidebar", () => {
  const expanded = workPanelLayout({
    containerWidth: 1200,
    sidebarWidth: 275,
    sidebarCollapsed: false,
    requestedPanelWidth: 500,
    maximized: true,
  });
  assert.equal(expanded.panelWidth, 925);
  assert.equal(expanded.maxPanelWidth, 925);
  assert.equal(expanded.mainWidth, 0);
  assert.equal(expanded.shouldCollapseSidebar, false);

  const collapsed = workPanelLayout({
    containerWidth: 1200,
    sidebarWidth: 275,
    sidebarCollapsed: true,
    requestedPanelWidth: 500,
    maximized: true,
  });
  assert.equal(collapsed.panelWidth, 1200);
  assert.equal(collapsed.mainWidth, 0);
});

test("clamps the work panel to its minimum without a fixed upper bound", () => {
  assert.equal(clampWorkPanelWidth(900), 900);
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
