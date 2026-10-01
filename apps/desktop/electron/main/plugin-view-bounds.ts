export type PluginViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Convert a renderer CSS-pixel rect into the unscaled DIPs
 * `WebContentsView.setBounds` expects. At zoomFactor 1 the two spaces match.
 */
export function scaleBoundsToDip(
  bounds: PluginViewBounds,
  zoomFactor: number,
): PluginViewBounds {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: Math.max(0, Math.round((Number(bounds.x) || 0) * zoom)),
    y: Math.max(0, Math.round((Number(bounds.y) || 0) * zoom)),
    width: Math.max(0, Math.round((Number(bounds.width) || 0) * zoom)),
    height: Math.max(0, Math.round((Number(bounds.height) || 0) * zoom)),
  };
}
