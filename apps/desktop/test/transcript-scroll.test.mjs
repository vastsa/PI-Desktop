import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIPT_REPIN_THRESHOLD_PX,
  TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
  isRecentScrollGesture,
  reduceTranscriptScroll,
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
