export const SIDEBAR_MENU_VIEWPORT_PADDING = 8;
export const SIDEBAR_FLOATING_MENU_MAX_HEIGHT = 360;

const SIDEBAR_MENU_ANCHOR_GAP = 4;

export type SidebarFloatingMenuAnchor = {
  top: number;
  bottom: number;
};

/** Place a floating sidebar menu near its anchor, inside the viewport. */
export function placeSidebarFloatingMenuTop(
  anchor: SidebarFloatingMenuAnchor,
  menuHeight: number,
  viewportHeight: number,
): number {
  const availableHeight = Math.max(
    0,
    viewportHeight - 2 * SIDEBAR_MENU_VIEWPORT_PADDING,
  );
  const height = Math.min(
    Math.max(0, menuHeight),
    SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
    availableHeight,
  );
  const minTop = SIDEBAR_MENU_VIEWPORT_PADDING;
  const maxTop = Math.max(
    minTop,
    viewportHeight - height - SIDEBAR_MENU_VIEWPORT_PADDING,
  );
  const belowTop = anchor.bottom + SIDEBAR_MENU_ANCHOR_GAP;
  const aboveTop = anchor.top - height - SIDEBAR_MENU_ANCHOR_GAP;
  const clampTop = (top: number) => Math.min(maxTop, Math.max(minTop, top));

  if (belowTop <= maxTop) return clampTop(belowTop);
  if (aboveTop >= minTop) return clampTop(aboveTop);

  const availableAbove = anchor.top - minTop - SIDEBAR_MENU_ANCHOR_GAP;
  const availableBelow =
    viewportHeight -
    SIDEBAR_MENU_VIEWPORT_PADDING -
    anchor.bottom -
    SIDEBAR_MENU_ANCHOR_GAP;
  return clampTop(availableAbove > availableBelow ? aboveTop : belowTop);
}
