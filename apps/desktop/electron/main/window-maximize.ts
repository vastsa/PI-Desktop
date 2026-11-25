import type { Rectangle } from "electron";

/**
 * How `toggleMaximize` should act on a window.
 *
 * - `unmaximize`: the window reports maximized; restore it.
 * - `restoreWindowed`: the native maximized flag was lost while the window
 *   still fills the work area (the Windows `frame:false` + `thickFrame:false`
 *   quirk behind issue #1993). Electron has no maximized state to restore
 *   into here — and on the transparent Win10 main window the recorded restore
 *   bounds are the full rect itself, so `maximize()+unmaximize()` is a
 *   no-op (review feedback on PR #2420) — so the toggle sets an explicit
 *   windowed rect instead.
 * - `maximize`: a plain windowed window; maximize it.
 */
export type MaximizeTogglePlan = "unmaximize" | "restoreWindowed" | "maximize";

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
    return "restoreWindowed";
  }
  return "maximize";
}

/**
 * The windowed rect a pseudo-maximized window is restored to.
 *
 * `lastNormal` is trusted only when it is a real windowed size: fully inside
 * the work area and not covering it. That matters because in the flag-lost
 * state Win32 reports the full rect as the window's normal position, so any
 * bounds recorded after the flag was lost are the very rect we are escaping.
 * Without a trustworthy rect the window gets two thirds of the work area,
 * centered.
 */
export function windowedRestoreBounds(input: {
  workArea: Rectangle;
  lastNormal: Rectangle | null;
  minWidth: number;
  minHeight: number;
}): Rectangle {
  const { workArea } = input;
  const lastNormal = input.lastNormal;
  if (
    lastNormal &&
    lastNormal.width >= input.minWidth &&
    lastNormal.height >= input.minHeight &&
    !boundsCoverWorkArea(lastNormal, workArea) &&
    lastNormal.x >= workArea.x &&
    lastNormal.y >= workArea.y &&
    lastNormal.x + lastNormal.width <= workArea.x + workArea.width &&
    lastNormal.y + lastNormal.height <= workArea.y + workArea.height
  ) {
    return lastNormal;
  }
  const width = Math.min(
    Math.max(Math.round(workArea.width * 2 / 3), input.minWidth),
    workArea.width,
  );
  const height = Math.min(
    Math.max(Math.round(workArea.height * 2 / 3), input.minHeight),
    workArea.height,
  );
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}
