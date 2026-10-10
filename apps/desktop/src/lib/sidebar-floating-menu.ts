export const SIDEBAR_MENU_VIEWPORT_PADDING = 8;
export const SIDEBAR_FLOATING_MENU_MAX_HEIGHT = 360;

/** Keep a floating sidebar menu inside the viewport with room for its full height. */
export function clampSidebarFloatingMenuTop(
  anchorTop: number,
  viewportHeight: number,
): number {
  return Math.max(
    SIDEBAR_MENU_VIEWPORT_PADDING,
    Math.min(
      anchorTop,
      viewportHeight - SIDEBAR_FLOATING_MENU_MAX_HEIGHT - SIDEBAR_MENU_VIEWPORT_PADDING,
    ),
  );
}
