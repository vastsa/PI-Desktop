/** Geometry is relative to the scroll viewport, not the document. */
export interface TranscriptContentGeometry {
  top: number;
  bottom: number;
  viewportHeight: number;
  width: number;
  measuredHeight: number | null;
  measuredWidth: number | null;
  mounted: boolean;
  /** Streaming, selection, focus, or an explicit navigation target. */
  protected: boolean;
}

/**
 * Retain addressable message shells while releasing expensive offscreen content.
 * Only a measurement at the current width is safe to use as a placeholder.
 * Different entry/exit buffers prevent churn near a virtualization boundary.
 * This policy does not evict history data or change the pagination cursor.
 */
export function shouldMountTranscriptContent(geometry: TranscriptContentGeometry): boolean {
  if (geometry.protected) return true;
  if (geometry.viewportHeight === 0) return geometry.mounted;
  const { top, bottom, width, measuredHeight, measuredWidth, viewportHeight } = geometry;
  if (
    !Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top ||
    !Number.isFinite(viewportHeight) || viewportHeight < 0 ||
    !Number.isFinite(width) || width <= 0 ||
    measuredHeight === null || !Number.isFinite(measuredHeight) || measuredHeight < 0 ||
    measuredWidth === null || !Number.isFinite(measuredWidth) || measuredWidth !== width
  ) return true;
  const buffer = viewportHeight * (geometry.mounted ? 5 : 3);
  return bottom >= -buffer && top <= viewportHeight + buffer;
}
