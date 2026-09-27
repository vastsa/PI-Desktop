export const TRANSCRIPT_REPIN_THRESHOLD_PX = 48;

export type TranscriptScrollInput = {
  previousScrollTop: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinned: boolean;
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
}: TranscriptScrollInput): TranscriptScrollTransition {
  const distanceFromBottom = Math.max(
    0,
    scrollHeight - scrollTop - clientHeight,
  );
  const movedUp = scrollTop < previousScrollTop;
  const movedDown = scrollTop > previousScrollTop;
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
