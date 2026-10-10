import type { BrowserWindow, Rectangle, Screen } from "electron";
import { MAX_WINDOW_CORNER_RADIUS } from "@pi-desktop/plugin-sdk";
import { isWindowFullScreen } from "./window-fullscreen.ts";

/** Matches the renderer's global `--radius-md` token (12px). */
export const DEFAULT_WINDOW_CORNER_RADIUS = 12;
const controllers = new WeakMap<BrowserWindow, { setRadius: (radius: number) => number }>();

type WindowShapeScreen = Pick<Screen, "getDisplayMatching" | "on" | "removeListener">;

/**
 * Build a native hit region that contains the antialiased edge painted by the
 * content view. The content view owns the visible curve; this region only
 * keeps clicks outside the rounded silhouette from reaching the window.
 */
export function roundedWindowHitRegion(width: number, height: number, radius: number): Rectangle[] {
  const corner = Math.min(Math.round(radius), Math.floor(width / 2), Math.floor(height / 2));
  if (corner <= 0) return [];

  const rects: Rectangle[] = [];
  for (let row = 0; row < corner; row += 1) {
    // Cover the full curve slice across this row, not only its midpoint. The
    // circle boundary moves inward as the row approaches the center, so use
    // its lower edge and round outward to keep antialiased coverage clickable.
    const distance = corner - row - 1;
    const inset = Math.max(
      0,
      Math.floor(corner - Math.sqrt(corner * corner - distance * distance)),
    );
    const band = { x: inset, width: width - inset * 2, height: 1 };
    rects.push({ ...band, y: row }, { ...band, y: height - row - 1 });
  }
  if (height > corner * 2) {
    rects.push({ x: 0, y: corner, width, height: height - corner * 2 });
  }
  return rects;
}

/** Keep the visible curve and native hit region synchronized with the window. */
export function installWindowShape(
  window: BrowserWindow,
  initialRadius = DEFAULT_WINDOW_CORNER_RADIUS,
  windowScreen?: WindowShapeScreen,
) {
  let radius = Math.max(0, Math.min(MAX_WINDOW_CORNER_RADIUS, Math.round(initialRadius)));
  let lastShape = "";
  const apply = (force = false) => {
    if (window.isDestroyed()) return;
    const { width, height } = window.contentView.getBounds();
    const rectangular = window.isMaximized() || isWindowFullScreen(window);
    const scaleFactor = windowScreen?.getDisplayMatching(window.getBounds()).scaleFactor ?? 1;
    const visibleRadius = rectangular ? 0 : radius;
    const shapeKey = `${width}:${height}:${scaleFactor}:${visibleRadius}`;
    if (!force && shapeKey === lastShape) return;

    window.contentView.setBorderRadius(visibleRadius);
    window.setShape(
      visibleRadius === 0 ? [] : roundedWindowHitRegion(width, height, visibleRadius),
    );
    lastShape = shapeKey;
  };

  // Windows can reset the native window region during visibility and monitor
  // transitions. Re-apply after those changes while retaining the chosen DIP
  // radius across maximized/fullscreen states.
  const reapply = () => apply(true);
  window.on("resize", apply);
  window.on("move", apply);
  window.on("maximize", apply);
  window.on("unmaximize", apply);
  window.on("enter-full-screen", apply);
  window.on("leave-full-screen", apply);
  window.on("show", reapply);
  window.on("restore", reapply);
  windowScreen?.on("display-metrics-changed", reapply);
  windowScreen?.on("display-added", reapply);
  windowScreen?.on("display-removed", reapply);

  const dispose = () => {
    window.removeListener("resize", apply);
    window.removeListener("move", apply);
    window.removeListener("maximize", apply);
    window.removeListener("unmaximize", apply);
    window.removeListener("enter-full-screen", apply);
    window.removeListener("leave-full-screen", apply);
    window.removeListener("show", reapply);
    window.removeListener("restore", reapply);
    window.removeListener("closed", dispose);
    windowScreen?.removeListener("display-metrics-changed", reapply);
    windowScreen?.removeListener("display-added", reapply);
    windowScreen?.removeListener("display-removed", reapply);
    controllers.delete(window);
  };
  window.once("closed", dispose);

  const controller = {
    setRadius(next: number) {
      radius = Math.max(0, Math.min(MAX_WINDOW_CORNER_RADIUS, Math.round(next)));
      apply();
      return radius;
    },
  };
  controllers.set(window, controller);
  apply();
  return controller;
}

export function setWindowCornerRadius(window: BrowserWindow, radius: number): number | null {
  return controllers.get(window)?.setRadius(radius) ?? null;
}
