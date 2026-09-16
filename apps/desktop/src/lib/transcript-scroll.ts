export const TRANSCRIPT_REPIN_THRESHOLD_PX = 48;

/**
 * Sub-pixel slack for scroll events that no user input produced.
 *
 * A fractional device pixel ratio makes the browser report a position a
 * fraction of a pixel away from the `scrollTop` a layout correction asked for
 * (at DPR 1.1: asked for 841, reported 840.909). Compared strictly that
 * fraction reads as the user scrolling up and drops follow mode. Callers pass
 * `tolerancePx: 0` for anything a real gesture produced, so an intentional
 * one-pixel scroll still unpins.
 */
export const TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX = 1;

export type TranscriptScrollInput = {
  previousScrollTop: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinned: boolean;
  /** Movement under this many pixels is not movement. */
  tolerancePx?: number;
};

export type TranscriptScrollTransition = {
  distanceFromBottom: number;
  movedUp: boolean;
  movedDown: boolean;
  releasedFollow: boolean;
  pinned: boolean;
  showJump: boolean;
};

/** Keep explicit follow mode separate from the near-bottom visual threshold. */
export function reduceTranscriptScroll({
  previousScrollTop,
  scrollTop,
  scrollHeight,
  clientHeight,
  wasPinned,
  tolerancePx = 0,
}: TranscriptScrollInput): TranscriptScrollTransition {
  const distanceFromBottom = Math.max(
    0,
    scrollHeight - scrollTop - clientHeight,
  );
  const movedUp = scrollTop < previousScrollTop - tolerancePx;
  const movedDown = scrollTop > previousScrollTop + tolerancePx;
  const nearBottom = distanceFromBottom < TRANSCRIPT_REPIN_THRESHOLD_PX;
  const releasedFollow = movedUp && distanceFromBottom > 0;
  const pinned = releasedFollow
    ? false
    : wasPinned || (movedDown && nearBottom);

  return {
    distanceFromBottom,
    movedUp,
    movedDown,
    releasedFollow,
    pinned,
    showJump: !pinned,
  };
}

/**
 * A real user scroll-up gesture (wheel, trackpad, touch, scrollbar drag,
 * keyboard) always precedes its scroll events by at most a frame or two, and
 * keeps firing while the gesture lasts. Programmatic follow scrolling and
 * layout-driven clamps (e.g. the composer collapsing after send) emit scroll
 * events with no preceding input.
 *
 * `handleScroll` releases follow only for events inside this window, so a
 * clamp between a follow `scrollTo` and its native event delivery can never
 * be mistaken for a user scrolling up.
 */
export const TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS = 200;

export function isRecentScrollGesture(
  now: number,
  lastGestureAt: number,
): boolean {
  return now - lastGestureAt <= TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS;
}

/** Keys whose native default moves the scroller the focused element sits in. */
export const SCROLL_GESTURE_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** Marks a scroll container so input can be attributed to the nearest one. */
export const SCROLL_OWNER_ATTRIBUTE = "data-scroll-owner";

export type ScrollInputType =
  | "wheel"
  | "touchstart"
  | "touchmove"
  | "pointerdown"
  | "keydown";

export type ScrollInputContext = {
  /** Pressed key, for a `keydown`. */
  key?: string;
  /** The key event came from a text field, which owns its own key input. */
  editable?: boolean;
  /**
   * A nearer, scrollable owner sits between the event target and this one, so
   * that owner consumes the input (`overscroll-behavior: contain` keeps it
   * there) and this one does not scroll at all.
   */
  nestedOwner?: boolean;
  /**
   * The pointer went down on this owner's own surface — its scrollbar, its
   * padding, or its content — rather than on one of its controls. A press on a
   * control or an editable field is an ordinary click and cannot start a
   * scroll.
   */
  pointerOnScrollSurface?: boolean;
};

/**
 * Whether a nested scroll owner would consume a vertical wheel or touch
 * gesture.
 *
 * Only the vertical axis counts. An element with horizontal overflow alone —
 * a wide `pre` in a marked region, for instance — still lets the gesture chain
 * to the scroller behind it, so that scroller has to own the input; treating it
 * as consumed would leave the outer viewport unmoved but un-followed, and the
 * next follow frame would drag the reader back to the bottom.
 */
export function consumesVerticalScroll(geometry: {
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return geometry.scrollHeight > geometry.clientHeight + 1;
}

/**
 * Whether a DOM input can actually move *this* container.
 *
 * Only such input may release follow or a held disclosure position. A click on
 * a control, a keystroke in a text field, and a gesture a nested scroller
 * consumes must not: marking them lets the very next programmatic follow
 * scroll look like the user scrolling up.
 */
export function isScrollGestureInput(
  type: ScrollInputType,
  context: ScrollInputContext = {},
): boolean {
  if (context.nestedOwner) return false;
  if (type === "pointerdown") return context.pointerOnScrollSurface === true;
  if (type === "keydown") {
    if (context.editable) return false;
    return context.key !== undefined && SCROLL_GESTURE_KEYS.has(context.key);
  }
  return true;
}
