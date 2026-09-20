/**
 * Placement math for a pointer-anchored context menu.
 *
 * A right-click menu has no trigger edge to align to: the pointer names where
 * it should appear. A menu that does not fit is therefore clamped inside the
 * viewport instead of flipped to the anchor's other side, which is the same
 * fallback the sidebar's body-level menus use for the same reason.
 *
 * The caller measures the rendered surface first and passes its size in, so the
 * first paint is already the final position and the menu can never flash at the
 * viewport origin.
 */

/** Keeps a floating surface off the window edge it would otherwise touch. */
export const CONTEXT_MENU_MARGIN = 8;

export type ContextMenuPoint = { x: number; y: number };
export type ContextMenuSize = { width: number; height: number };
export type ContextMenuPlacement = { top: number; left: number };

/**
 * A surface larger than the viewport cannot satisfy both margins. `min` is
 * returned in that case so the menu's top-left stays reachable and its own
 * `max-height`/`overflow` scrolls the remainder.
 */
function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

export function placeContextMenu(
  point: ContextMenuPoint,
  surface: ContextMenuSize,
  viewport: ContextMenuSize,
  margin: number = CONTEXT_MENU_MARGIN,
): ContextMenuPlacement {
  const maxLeft = viewport.width - surface.width - margin;
  const maxTop = viewport.height - surface.height - margin;
  return {
    // Rounded so the surface lands on a whole pixel: a half-pixel offset makes
    // every item's hairline separator blur.
    left: Math.round(clamp(point.x, margin, maxLeft)),
    top: Math.round(clamp(point.y, margin, maxTop)),
  };
}
