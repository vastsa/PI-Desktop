/**
 * Reading position held across one manual disclosure (#324).
 *
 * The transcript turns native scroll anchoring off (`.thread-scroll` sets
 * `overflow-anchor: none`), so the browser does not keep a row in place when
 * the content around it changes height, and pinned follow cannot either: it
 * re-bottoms on every content resize, which is exactly what dragged a clicked
 * tool/thinking/activity title out of view. A manual disclosure therefore hands
 * the owning scroller the title it was toggled from, and that scroller restores
 * this anchor from its own ResizeObserver for as many frames as the height
 * keeps changing (an activity group animates its `grid-template-rows`).
 *
 * The anchor is the title's top relative to the scroller's top edge, not a
 * `scrollTop`, so a simultaneous height change *above* the title — a collapsed
 * row, a prepended history page — is compensated as well.
 */

/** Sub-pixel slack for "the viewport already holds the anchor". */
export const DISCLOSURE_ANCHOR_TOLERANCE_PX = 0.5;

export type DisclosureAnchor = {
  /** Title top relative to the scroller's top edge when it was toggled. */
  offset: number;
};

export type DisclosureAnchorFrame = {
  /** Title top relative to the scroller's top edge, measured now. */
  elementOffset: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function disclosureAnchorOffset(
  scrollerTop: number,
  elementTop: number,
): number {
  return elementTop - scrollerTop;
}

/** Where the anchored title currently sits in the scroller's own content. */
export function disclosureContentTop(frame: DisclosureAnchorFrame): number {
  return frame.elementOffset + frame.scrollTop;
}

/**
 * The `scrollTop` that puts the anchored title back where it was, or `null`
 * when the viewport already holds it: a settled frame must not write the
 * scroller, because every write emits a scroll event.
 *
 * The result is clamped to the scrollable range, so a correction that cannot be
 * reached (the content shrank under the anchor) leaves the browser's own
 * boundary position alone.
 */
export function resolveDisclosureAnchor(
  anchor: DisclosureAnchor,
  frame: DisclosureAnchorFrame,
): number | null {
  const maxScrollTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  const target = Math.min(
    maxScrollTop,
    Math.max(0, disclosureContentTop(frame) - anchor.offset),
  );
  return Math.abs(target - frame.scrollTop) < DISCLOSURE_ANCHOR_TOLERANCE_PX
    ? null
    : target;
}

/**
 * The anchor to hold after a correction was applied: the position the title
 * actually reached. A boundary clamp is the browser's answer, so adopting it
 * stops the next frame from fighting it.
 */
export function adoptDisclosureAnchor(
  frame: DisclosureAnchorFrame,
): DisclosureAnchor {
  return { offset: frame.elementOffset };
}
