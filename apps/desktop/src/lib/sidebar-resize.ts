import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./sidebar-preferences.ts";
import { MAIN_PANE_MIN_WIDTH, WORK_PANEL_MIN_WIDTH } from "./work-panel-resize.ts";

/** Keyboard and pointer step for the expanded-sidebar separator. */
export const SIDEBAR_RESIZE_STEP = 16;

/**
 * Pointer width below this collapses the sidebar instead of leaving a cramped
 * column. The preferred expanded width is left untouched.
 */
export const SIDEBAR_COLLAPSE_THRESHOLD = 160;

export type SidebarPointerResize =
  | { type: "width"; width: number }
  | { type: "collapse" };

export function sidebarPointerResize({
  startWidth,
  deltaX,
  maxWidth = SIDEBAR_WIDTH_MAX,
}: {
  startWidth: number;
  deltaX: number;
  maxWidth?: number;
}): SidebarPointerResize {
  if (!Number.isFinite(startWidth) || !Number.isFinite(deltaX)) {
    return {
      type: "width",
      width: clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, maxWidth),
    };
  }
  const raw = startWidth + deltaX;
  if (raw < SIDEBAR_COLLAPSE_THRESHOLD) return { type: "collapse" };
  return { type: "width", width: clampSidebarWidth(raw, maxWidth) };
}

/**
 * Double-click reset for the expanded-sidebar separator. The default stays
 * inside the live budget so resetting a squeezed three-column window cannot
 * push MainChat under its 450px floor.
 */
export function sidebarResetWidth(maxWidth = SIDEBAR_WIDTH_MAX): number {
  return clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, maxWidth);
}

/**
 * Live upper bound for a user-chosen sidebar width. The three-column budget
 * still belongs to MainChat: this cap keeps a resize from crossing the 450px
 * floor and tripping D408's sidebar yield.
 */
export function sidebarWidthBudget({
  containerWidth,
  workPanelOpen,
  workPanelWidth,
  workPanelMaximized = false,
}: {
  containerWidth: number;
  workPanelOpen: boolean;
  workPanelWidth: number;
  workPanelMaximized?: boolean;
}): number {
  const width = Math.max(0, Math.round(containerWidth));
  if (width <= 0) return SIDEBAR_WIDTH_MAX;
  if (workPanelMaximized) {
    return Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, width - WORK_PANEL_MIN_WIDTH),
    );
  }
  const panel = workPanelOpen ? Math.max(0, Math.round(workPanelWidth)) : 0;
  const budget = width - MAIN_PANE_MIN_WIDTH - panel - 1;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, budget));
}
