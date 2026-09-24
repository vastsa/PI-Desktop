export const WORK_PANEL_TAB_REORDER_ARM_PX = 8;
export const WORK_PANEL_TAB_REORDER_EDGE_PX = 32;
export const WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX = 12;

export function workPanelTabReorderShouldArm(
  dx: number,
  dy: number,
  thresholdPx = WORK_PANEL_TAB_REORDER_ARM_PX,
): boolean {
  return dx * dx + dy * dy > thresholdPx * thresholdPx;
}

export function workPanelTabReorderInsertAfter(
  clientX: number,
  targetLeft: number,
  targetWidth: number,
): boolean {
  return clientX > targetLeft + targetWidth / 2;
}

/** Return the per-frame horizontal scroll speed for a pointer near either edge. */
export function workPanelTabReorderScrollDelta(
  clientX: number,
  stripLeft: number,
  stripRight: number,
  edgePx = WORK_PANEL_TAB_REORDER_EDGE_PX,
  maxScrollPx = WORK_PANEL_TAB_REORDER_MAX_SCROLL_PX,
): number {
  const leftProgress = (stripLeft + edgePx - clientX) / edgePx;
  if (leftProgress > 0) {
    return -Math.ceil(Math.min(1, leftProgress) * maxScrollPx);
  }

  const rightProgress = (clientX - (stripRight - edgePx)) / edgePx;
  if (rightProgress > 0) {
    return Math.ceil(Math.min(1, rightProgress) * maxScrollPx);
  }

  return 0;
}
