/**
 * Type-scale propagation for docked plugin work-panel views.
 *
 * A docked view is its own web page, so neither the renderer's `--font-scale`
 * (D343 / ADR 0180) nor the window's own zoom reaches it: the plugin page keeps
 * painting its author-sized 12px/13px chrome while the app around it grows.
 * The host repeats the same factor as that page's zoom instead. At
 * `fontScale * windowZoom` one CSS pixel inside the plugin paints at the same
 * DIP size as one CSS pixel in the app, so text and control proportions match
 * without asking plugins to ship a host design-token ramp.
 *
 * The rules stay here, free of Electron, so they are unit-testable.
 */

export const DEFAULT_PLUGIN_VIEW_SCALE = 1;

/** Coerce a settings or window value into a usable zoom factor. */
export function normalizePluginViewScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PLUGIN_VIEW_SCALE;
  }
  return value;
}

/**
 * Zoom one docked view page needs to match the app: the Appearance type scale
 * multiplied by the window zoom, because the app paints both in one window.
 *
 * Rounded so a settled pair of factors does not re-apply a zoom that only
 * differs in floating-point noise.
 */
export function pluginViewZoom(scale: number, windowZoom: number): number {
  const composed =
    normalizePluginViewScale(scale) * normalizePluginViewScale(windowZoom);
  return Number(composed.toFixed(4));
}