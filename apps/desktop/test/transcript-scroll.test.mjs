import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_REVEAL_THRESHOLD_PX,
  TRANSCRIPT_REPIN_THRESHOLD_PX,
  TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
  isHistoryRevealPosition,
  isRecentScrollGesture,
  reduceTranscriptScroll,
  transcriptHasLayout,
} from "../src/lib/transcript-scroll.ts";

function update(overrides = {}) {
  return reduceTranscriptScroll({
    previousScrollTop: 500,
    scrollTop: 500,
    scrollHeight: 1_000,
    clientHeight: 500,
    wasPinned: true,
    ...overrides,
  });
}

test("the first small upward scroll releases transcript follow", () => {
  const result = update({ scrollTop: 499 });

  assert.equal(result.movedUp, true);
  assert.equal(result.releasedFollow, true);
  assert.equal(result.pinned, false);
  assert.equal(result.showJump, true);
});

test("layout clamping at the exact bottom preserves transcript follow", () => {
  const result = update({
    previousScrollTop: 500,
    scrollTop: 480,
    scrollHeight: 980,
  });

  assert.equal(result.movedUp, true);
  assert.equal(result.distanceFromBottom, 0);
  assert.equal(result.releasedFollow, false);
  assert.equal(result.pinned, true);
  assert.equal(result.showJump, false);
});

test("content growth cannot re-pin a manually released transcript", () => {
  const result = update({
    previousScrollTop: 499,
    scrollTop: 499,
    scrollHeight: 1_008,
    wasPinned: false,
  });

  assert.equal(result.distanceFromBottom, 9);
  assert.equal(result.pinned, false);
});

test("scrolling down near the bottom resumes transcript follow", () => {
  const result = update({
    previousScrollTop: 450,
    scrollTop: 500 - TRANSCRIPT_REPIN_THRESHOLD_PX + 1,
    wasPinned: false,
  });

  assert.equal(result.movedDown, true);
  assert.equal(result.pinned, true);
  assert.equal(result.showJump, false);
});

test("programmatic downward scrolling keeps existing follow mode pinned", () => {
  const result = update({
    previousScrollTop: 200,
    scrollTop: 250,
  });

  assert.equal(result.movedDown, true);
  assert.equal(result.pinned, true);
  assert.equal(result.showJump, false);
});

test("jump control stays visible while an unpinned transcript is away from bottom", () => {
  const result = update({
    previousScrollTop: 420,
    scrollTop: 421,
    wasPinned: false,
  });

  assert.equal(result.pinned, false);
  assert.equal(result.showJump, true);
});

test("a scroll event that follows user input is a gesture", () => {
  assert.equal(isRecentScrollGesture(100, 99), true);
  assert.equal(
    isRecentScrollGesture(
      TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
      0,
    ),
    true,
  );
});

test("a scroll event without recent user input is not a gesture", () => {
  assert.equal(
    isRecentScrollGesture(
      TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS + 1,
      0,
    ),
    false,
  );
  assert.equal(isRecentScrollGesture(100, -Infinity), false);
});

test("a collapsed scroller has no layout", () => {
  assert.equal(transcriptHasLayout({ scrollHeight: 0, clientHeight: 0 }), false);
  assert.equal(transcriptHasLayout({ scrollHeight: 800, clientHeight: 0 }), false);
  assert.equal(transcriptHasLayout({ scrollHeight: 800, clientHeight: 400 }), true);
});

test("a collapsed scroller is not a history-reveal position", () => {
  assert.equal(
    isHistoryRevealPosition({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
    false,
  );
});

test("a pinned overflowing transcript does not page from a stale zero offset", () => {
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 4_000, clientHeight: 800 },
      true,
    ),
    false,
  );
});

test("an underfilled pinned tail still reveals earlier history", () => {
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 400, clientHeight: 800 },
      true,
    ),
    true,
  );
});

test("an unpinned transcript at the top reveals earlier history", () => {
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: HISTORY_REVEAL_THRESHOLD_PX, scrollHeight: 4_000, clientHeight: 800 },
      false,
    ),
    true,
  );
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: HISTORY_REVEAL_THRESHOLD_PX + 1, scrollHeight: 4_000, clientHeight: 800 },
      false,
    ),
    false,
  );
});

test("a one-pixel overflow is not a pinned overflowing transcript", () => {
  // The overflow test is deliberately slack by one pixel: a fractional layout
  // can leave a single pixel that no scroll event can retire, and a pinned
  // transcript there is genuinely at its own top.
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 801, clientHeight: 800 },
      true,
    ),
    true,
  );
  assert.equal(
    isHistoryRevealPosition(
      { scrollTop: 0, scrollHeight: 802, clientHeight: 800 },
      true,
    ),
    false,
  );
});

test("a pinned overflowing transcript is suppressed anywhere in the band", () => {
  // The suppression is about the offset being stale, not about it being zero:
  // the caller passes `pinned` only for an offset its own event did not produce.
  assert.equal(
    isHistoryRevealPosition(
      {
        scrollTop: HISTORY_REVEAL_THRESHOLD_PX,
        scrollHeight: 900,
        clientHeight: 800,
      },
      true,
    ),
    false,
  );
  assert.equal(
    isHistoryRevealPosition(
      {
        scrollTop: HISTORY_REVEAL_THRESHOLD_PX + 1,
        scrollHeight: 900,
        clientHeight: 800,
      },
      true,
    ),
    false,
  );
});
