/**
 * Content-driven height math for the launcher panel.
 *
 * The panel no longer opens at a remembered, user-dragged height: it measures
 * what it renders and asks the main process for exactly that height. The
 * arithmetic lives here, free of the DOM and of `BrowserWindow`, so the
 * conversion can be unit-tested on its own.
 */

/** The pieces of the panel that add up to the window content height. */
export type LauncherContentParts = {
  /** Height of the search row. */
  searchRowHeight: number;
  /** Natural height of the results viewport: content plus the scroller padding. */
  resultsHeight: number;
  /** Height of the footer bar. */
  footerHeight: number;
  /** Panel padding plus the frame border drawn around the surface. */
  chromeHeight: number;
};

/**
 * Total content height for one render.
 *
 * Rounded up — a fractional measurement would otherwise leave a one-pixel
 * scrollbar on a panel that fits — and floored at zero, so a collapsed layout
 * during teardown never asks for a negative window.
 */
export function resolveLauncherContentHeight(
  parts: LauncherContentParts,
): number {
  const total =
    parts.searchRowHeight +
    parts.resultsHeight +
    parts.footerHeight +
    parts.chromeHeight;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.ceil(total);
}
