import type { Rectangle } from "electron";

/**
 * How `toggleMaximize` should act on a window.
 *
 * - `unmaximize`: the window reports maximized; restore it.
 * - `resyncUnmaximize`: the native maximized flag was lost while the window
 *   still fills the work area (the Windows `frame:false` + `thickFrame:false`
 *   quirk behind issue #1993). Re-assert the maximized state first so the
 *   follow-up `unmaximize()` has a real maximized state to restore from.
 * - `maximize`: a plain windowed window; maximize it.
 */
export type MaximizeTogglePlan = "unmaximize" | "resyncUnmaximize" | "maximize";

/**
 * Bounds and work areas are integer pixels, but display changes and DPI
 * rounding leave off-by-small amounts, so "covers the work area" allows a
 * small slack instead of exact containment.
 */
const COVER_SLACK_PX = 8;

export function boundsCoverWorkArea(bounds: Rectangle, workArea: Rectangle): boolean {
  return (
    bounds.x <= workArea.x + COVER_SLACK_PX &&
    bounds.y <= workArea.y + COVER_SLACK_PX &&
    bounds.x + bounds.width >= workArea.x + workArea.width - COVER_SLACK_PX &&
    bounds.y + bounds.height >= workArea.y + workArea.height - COVER_SLACK_PX
  );
}

/**
 * Decide how `toggleMaximize` acts, from plain data so the Windows flag-loss
 * path is unit-testable without Electron.
 *
 * The geometric fallback is Windows-only: the flag loss it heals is the
 * win32 `frame:false` + `thickFrame:false` quirk (#1993). Elsewhere a
 * window that merely covers the work area is an ordinary user-resized
 * window, and maximizing it must keep the plain behavior.
 *
 * A fullscreen window never counts as pseudo-maximized: its bounds cover
 * the work area too, but its toggle must keep running through the existing
 * exit-fullscreen-then-maximize path (issue #1655).
 */
export function planMaximizeToggle(input: {
  isMaximized: boolean;
  isFullScreen: boolean;
  platform: string;
  bounds: Rectangle;
  workArea: Rectangle | null;
}): MaximizeTogglePlan {
  if (input.isMaximized) return "unmaximize";
  if (
    input.platform === "win32" &&
    !input.isFullScreen &&
    input.workArea &&
    boundsCoverWorkArea(input.bounds, input.workArea)
  ) {
    return "resyncUnmaximize";
  }
  return "maximize";
}
