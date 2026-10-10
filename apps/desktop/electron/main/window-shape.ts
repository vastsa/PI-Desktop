import type { BrowserWindow, Rectangle } from "electron";
import { MAX_WINDOW_CORNER_RADIUS } from "@pi-desktop/plugin-sdk";
import { isWindowFullScreen } from "./window-fullscreen.ts";

/** Matches the renderer's global `--radius-md` token (12px). */
export const DEFAULT_WINDOW_CORNER_RADIUS = 12;
const controllers = new WeakMap<BrowserWindow, { setRadius: (radius: number) => number }>();

/** Pixel rows approximate a quarter circle without changing window bounds. */
export function roundedWindowShape(width: number, height: number, radius: number): Rectangle[] {
  const corner = Math.min(Math.round(radius), Math.floor(width / 2), Math.floor(height / 2));
  if (corner <= 0) return [];
  const rects: Rectangle[] = [];
  for (let row = 0; row < corner; row += 1) {
    const distance = corner - row - 0.5;
    const inset = Math.max(0, Math.ceil(corner - Math.sqrt(corner * corner - distance * distance) - 0.5));
    const band = { x: inset, width: width - inset * 2, height: 1 };
    rects.push({ ...band, y: row }, { ...band, y: height - row - 1 });
  }
  if (height > corner * 2) {
    rects.push({ x: 0, y: corner, width, height: height - corner * 2 });
  }
  return rects;
}

/** Keep the native hit region matched to the current window dimensions. */
export function installWindowShape(window: BrowserWindow, initialRadius = DEFAULT_WINDOW_CORNER_RADIUS) {
  let radius = initialRadius;
  let lastShape = "";
  const apply = (force = false) => {
    if (window.isDestroyed()) return;
    const { width, height } = window.getBounds();
    const rectangular = window.isMaximized() || isWindowFullScreen(window);
    const shapeKey = `${width}:${height}:${rectangular ? 0 : radius}`;
    if (!force && shapeKey === lastShape) return;
    window.setShape(rectangular ? [] : roundedWindowShape(width, height, radius));
    lastShape = shapeKey;
  };
  // Windows can reset the native window region during visibility transitions.
  const reapply = () => apply(true);
  window.on("resize", apply);
  window.on("maximize", apply);
  window.on("unmaximize", apply);
  window.on("enter-full-screen", apply);
  window.on("leave-full-screen", apply);
  window.on("show", reapply);
  window.on("restore", reapply);
  const dispose = () => {
    window.removeListener("resize", apply);
    window.removeListener("maximize", apply);
    window.removeListener("unmaximize", apply);
    window.removeListener("enter-full-screen", apply);
    window.removeListener("leave-full-screen", apply);
    window.removeListener("show", reapply);
    window.removeListener("restore", reapply);
    window.removeListener("closed", dispose);
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
