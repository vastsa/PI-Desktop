import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptDisclosureAnchor,
  DISCLOSURE_ANCHOR_TOLERANCE_PX,
  disclosureAnchorOffset,
  disclosureContentTop,
  resolveDisclosureAnchor,
} from "../src/lib/disclosure-anchor.ts";
import {
  consumesVerticalScroll,
  isScrollGestureInput,
  reduceTranscriptScroll,
  SCROLL_GESTURE_KEYS,
  SCROLL_OWNER_ATTRIBUTE,
  TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
} from "../src/lib/transcript-scroll.ts";

const anchor = (offset) => ({ offset });
const frame = (overrides = {}) => ({
  elementOffset: 0,
  scrollTop: 0,
  scrollHeight: 1_260,
  clientHeight: 600,
  ...overrides,
});

test("the anchor is measured against the scroller's own top edge", () => {
  assert.equal(disclosureAnchorOffset(40, 160), 120);
  assert.equal(disclosureAnchorOffset(40, 40), 0);
});

test("the anchored title's content position is independent of the scroll offset", () => {
  assert.equal(
    disclosureContentTop(frame({ elementOffset: 120, scrollTop: 660 })),
    780,
  );
  assert.equal(
    disclosureContentTop(frame({ elementOffset: 120, scrollTop: 0 })),
    120,
  );
});

test("expanding below the title needs no correction at all", () => {
  // Issue #324's measurement: 240px of detail appears under a title that sits
  // 120px below the scroller top. The title's content position does not move,
  // so the viewport already holds it and the scroller must not be written.
  const expanded = frame({
    elementOffset: 120,
    scrollTop: 660,
    scrollHeight: 1_500,
  });

  assert.equal(resolveDisclosureAnchor(anchor(120), expanded), null);
});

test("content that shrinks above the title moves the viewport back to it", () => {
  // A row above the title collapsed: the title's content position dropped by
  // 60px, so the viewport has to move up by the same amount.
  const shifted = frame({
    elementOffset: 60,
    scrollTop: 900,
    scrollHeight: 1_600,
  });

  assert.equal(resolveDisclosureAnchor(anchor(120), shifted), 840);
});

test("a correction the content cannot reach stops at the boundary", () => {
  const shifted = frame({
    elementOffset: 60,
    scrollTop: 900,
    scrollHeight: 1_260,
  });

  assert.equal(resolveDisclosureAnchor(anchor(120), shifted), 660);
});

test("a settled frame does not write the scroller", () => {
  const settled = frame({
    elementOffset: 120 + DISCLOSURE_ANCHOR_TOLERANCE_PX / 2,
    scrollTop: 660,
    scrollHeight: 1_500,
  });

  assert.equal(resolveDisclosureAnchor(anchor(120), settled), null);
});

test("the position the browser settled on becomes the new anchor", () => {
  // The browser clamped the correction, so the title ends up further down than
  // asked. Adopting that position is what stops the next frame fighting it.
  const settled = frame({
    elementOffset: 300,
    scrollTop: 660,
    scrollHeight: 1_260,
  });

  assert.deepEqual(adoptDisclosureAnchor(settled), {
    offset: 300,
  });
});

test("a fractional device pixel ratio is not read as scrolling up", () => {
  // At DPR 1.1 follow asked for 841 and the scroller settled on 840.909. The
  // fraction is the browser rounding, not the reader moving.
  const transition = reduceTranscriptScroll({
    previousScrollTop: 841,
    scrollTop: 840.909,
    scrollHeight: 1_500,
    clientHeight: 600,
    wasPinned: true,
    tolerancePx: TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
  });

  assert.equal(transition.movedUp, false);
  assert.equal(transition.releasedFollow, false);
  assert.equal(transition.pinned, true);
});

test("a real gesture still unpins on a one-pixel scroll up", () => {
  const transition = reduceTranscriptScroll({
    previousScrollTop: 841,
    scrollTop: 840,
    scrollHeight: 1_500,
    clientHeight: 600,
    wasPinned: true,
    tolerancePx: 0,
  });

  assert.equal(transition.movedUp, true);
  assert.equal(transition.releasedFollow, true);
  assert.equal(transition.pinned, false);
  assert.equal(transition.showJump, true);
});

test("without a tolerance the same fraction does release follow", () => {
  // Guards the tolerance's own necessity: the product only passes it for
  // events no gesture produced.
  const transition = reduceTranscriptScroll({
    previousScrollTop: 841,
    scrollTop: 840.909,
    scrollHeight: 1_500,
    clientHeight: 600,
    wasPinned: true,
  });

  assert.equal(transition.releasedFollow, true);
});

test("only vertical overflow lets a nested owner consume the gesture", () => {
  // A wide `pre` in a marked region scrolls sideways, not down: the wheel still
  // scrolls the transcript behind it, so the transcript has to own the input.
  assert.equal(
    consumesVerticalScroll({ scrollHeight: 400, clientHeight: 300 }),
    true,
  );
  assert.equal(
    consumesVerticalScroll({ scrollHeight: 300, clientHeight: 300 }),
    false,
  );
  // Sub-pixel layout rounding is not overflow.
  assert.equal(
    consumesVerticalScroll({ scrollHeight: 300.5, clientHeight: 300 }),
    false,
  );
});


test("wheel and touch input move the scroller", () => {
  assert.equal(isScrollGestureInput("wheel"), true);
  assert.equal(isScrollGestureInput("touchstart"), true);
  assert.equal(isScrollGestureInput("touchmove"), true);
});

test("a scroll key is a gesture, and Space stays a button activation", () => {
  assert.equal(isScrollGestureInput("keydown", { key: "ArrowUp" }), true);
  assert.equal(isScrollGestureInput("keydown", { key: "PageDown" }), true);
  assert.equal(isScrollGestureInput("keydown", { key: "Home" }), true);
  assert.equal(isScrollGestureInput("keydown", { key: " " }), true);
  assert.equal(SCROLL_GESTURE_KEYS.has("ArrowDown"), true);
  assert.equal(isScrollGestureInput("keydown", { key: "a" }), false);
  assert.equal(isScrollGestureInput("keydown", {}), false);
});

test("a keystroke in a text field is not a scroll", () => {
  assert.equal(
    isScrollGestureInput("keydown", { key: "ArrowDown", editable: true }),
    false,
  );
});

test("only a press on the scroller's own surface starts a scroll", () => {
  // A press on a row, a control or an editable field is an ordinary click: it
  // must not let the next programmatic follow scroll look like a gesture.
  assert.equal(isScrollGestureInput("pointerdown"), false);
  assert.equal(
    isScrollGestureInput("pointerdown", { pointerOnScrollSurface: false }),
    false,
  );
  assert.equal(
    isScrollGestureInput("pointerdown", { pointerOnScrollSurface: true }),
    true,
  );
});

test("input a nested scroller consumes is not this scroller's gesture", () => {
  assert.equal(isScrollGestureInput("wheel", { nestedOwner: true }), false);
  assert.equal(
    isScrollGestureInput("pointerdown", {
      nestedOwner: true,
      pointerOnScrollSurface: true,
    }),
    false,
  );
});

test("scroll owners are found by one shared attribute", () => {
  assert.equal(SCROLL_OWNER_ATTRIBUTE, "data-scroll-owner");
});
