// The tab strip needs enough room to expose useful context beside the fixed
// Windows/Linux titlebar reservation. Existing persisted widths remain intact;
// this only affects a new profile without a saved preference.
export const WORK_PANEL_MIN_WIDTH = 244;
export const WORK_PANEL_DEFAULT_WIDTH = 360;
export const WORK_PANEL_MAX_WIDTH = 720;
export const WORK_PANEL_CHAT_MIN_WIDTH = 1040;
export const WORK_PANEL_CHAT_MAX_WIDTH = 10000;
/**
 * Hard MainChat floor for the in-flow three-column shell. The work panel may
 * never take width below it, and the expanded sidebar yields first. This
 * replaces the 515px composer reservation of ADR 0226; the composer keeps its
 * own single-row behavior once the chat column is this narrow.
 */
export const MAIN_PANE_MIN_WIDTH = 360;
export const MAIN_PANE_REOPEN_TARGET_WIDTH = MAIN_PANE_MIN_WIDTH + 10;
/**
 * The regular panel minimum is a presentation affordance. The sidebar reopen
 * path may temporarily spend the whole right column to preserve MainChat, so
 * a positive compact width must remain representable in persisted state.
 */
export const WORK_PANEL_COMPACT_MIN_WIDTH = 1;

export type WorkPanelChatResizeGesture = {
  startClientX: number;
  startWidth: number;
};

export function workPanelWidthLimits(min = WORK_PANEL_MIN_WIDTH) {
  return {
    min: Math.max(WORK_PANEL_COMPACT_MIN_WIDTH, Math.min(WORK_PANEL_MAX_WIDTH, min)),
    max: WORK_PANEL_MAX_WIDTH,
  };
}

export function clampWorkPanelWidth(
  width: number,
  min = WORK_PANEL_MIN_WIDTH,
) {
  const limits = workPanelWidthLimits(min);
  return Math.max(limits.min, Math.min(limits.max, width));
}

export type WorkPanelLayout = {
  mainWidth: number;
  panelWidth: number;
  maxPanelWidth: number;
  shouldCollapseSidebar: boolean;
};

/**
 * Shared three-column budget. The shell is a fixed-width client area, so the
 * only way to satisfy the MainChat floor is to cap the panel and, at the
 * threshold, collapse the sidebar.
 */
export function workPanelLayout({
  containerWidth,
  sidebarWidth,
  sidebarCollapsed,
  requestedPanelWidth,
}: {
  containerWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  requestedPanelWidth: number;
}): WorkPanelLayout {
  const width = Math.max(0, Math.round(containerWidth));
  const leftWidth = sidebarCollapsed ? 0 : Math.max(0, Math.round(sidebarWidth));
  const requested = clampWorkPanelWidth(
    requestedPanelWidth,
    requestedPanelWidth < WORK_PANEL_MIN_WIDTH
      ? WORK_PANEL_COMPACT_MIN_WIDTH
      : WORK_PANEL_MIN_WIDTH,
  );
  const maxPanelWidth = Math.max(
    0,
    Math.min(
      WORK_PANEL_MAX_WIDTH,
      width - leftWidth - MAIN_PANE_MIN_WIDTH,
    ),
  );
  const panelWidth = Math.min(requested, maxPanelWidth);
  return {
    mainWidth: Math.max(0, width - leftWidth - panelWidth),
    panelWidth,
    maxPanelWidth,
    shouldCollapseSidebar:
      !sidebarCollapsed &&
      width - leftWidth - requestedPanelWidth <= MAIN_PANE_MIN_WIDTH,
  };
}

/**
 * Computes the right-column width used while manually reopening the sidebar.
 * The right column gives up its space first, preserving the current MainChat
 * width. If that cannot keep the 360px hard floor, the 370px reopen target is
 * used as the next best stable width.
 */
export function workPanelWidthForSidebarReopen({
  containerWidth,
  sidebarWidth,
  currentPanelWidth,
}: {
  containerWidth: number;
  sidebarWidth: number;
  currentPanelWidth: number;
}) {
  const width = Math.max(0, Math.round(containerWidth));
  const leftWidth = Math.max(0, Math.round(sidebarWidth));
  const panelWidth = clampWorkPanelWidth(
    currentPanelWidth,
    currentPanelWidth < WORK_PANEL_MIN_WIDTH
      ? WORK_PANEL_COMPACT_MIN_WIDTH
      : WORK_PANEL_MIN_WIDTH,
  );
  const remainingAfterSidebar = width - leftWidth;
  const preservedMainWidth = remainingAfterSidebar - panelWidth;
  const targetMainWidth =
    preservedMainWidth >= MAIN_PANE_MIN_WIDTH
      ? preservedMainWidth
      : MAIN_PANE_REOPEN_TARGET_WIDTH;
  return Math.max(
    WORK_PANEL_COMPACT_MIN_WIDTH,
    Math.min(panelWidth, remainingAfterSidebar - targetMainWidth),
  );
}

export function clampWorkPanelChatWidth(width: number) {
  return Math.max(
    WORK_PANEL_CHAT_MIN_WIDTH,
    Math.min(WORK_PANEL_CHAT_MAX_WIDTH, Math.round(width)),
  );
}

export function workPanelChatWidthFromPointer(
  gesture: WorkPanelChatResizeGesture,
  clientX: number,
) {
  return clampWorkPanelChatWidth(
    gesture.startWidth + clientX - gesture.startClientX,
  );
}

export function parseWorkPanelChatWidth(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const width = (input as { width?: unknown }).width;
  if (
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < WORK_PANEL_CHAT_MIN_WIDTH ||
    width > WORK_PANEL_CHAT_MAX_WIDTH
  ) {
    return null;
  }
  return width;
}

export function committedWorkPanelChatWidth(
  gesture: WorkPanelChatResizeGesture,
  previewWidth: number,
  commit: boolean,
) {
  if (!commit || previewWidth === gesture.startWidth) return null;
  return previewWidth;
}
