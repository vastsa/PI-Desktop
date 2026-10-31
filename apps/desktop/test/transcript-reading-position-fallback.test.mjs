import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// `restoreTranscriptReadingPosition` escapes the id with the browser-only
// `CSS.escape`; this suite runs the function directly in Node.
globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
const { restoreTranscriptReadingPosition } = await import(
  "../src/lib/transcript-reading-position.ts"
);

/*
  #1771, the path #1783 does not cover.

  A reveal mounts only a trailing slice of history
  (lib/transcript-window.ts:23-28: TRANSCRIPT_INITIAL_MOUNT 15, then
  TRANSCRIPT_WINDOW_MIN 60), so an older bookmark routinely names a row that is
  not in the DOM. Without a fallback, the restore loop did not move to the
  saved position. Real scroll gestures can cancel the pending restore, but
  without such a gesture the session returned at its initial position.

  The bookmark already carries the absolute offset it was taken at, so a
  missing row now falls back to that offset instead of reporting failure.
*/

/** Minimal stand-ins for the two DOM objects the function touches. */
function fakeScroller({ scrollTop = 0, top = 0 } = {}) {
  return {
    scrollTop,
    getBoundingClientRect: () => ({ top, bottom: top + 600, left: 0, right: 800 }),
    // `transcriptHasLayout` needs a real box.
    clientHeight: 600,
    scrollHeight: 1200,
    offsetHeight: 600,
  };
}
function fakeContent({ row = null } = {}) {
  return {
    querySelector: () => row,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    offsetHeight: 1200,
  };
}

const bookmark = (overrides = {}) => ({
  pinned: false,
  messageId: "m-late",
  offset: 24,
  scrollTop: 480,
  windowSize: 60,
  ...overrides,
});

test("an anchored row that is mounted still restores by its rect", () => {
  const scroller = fakeScroller({ scrollTop: 100, top: 0 });
  const row = {
    getBoundingClientRect: () => ({ top: 140, bottom: 200, height: 60, left: 0, right: 800 }),
    offsetHeight: 60,
  };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row }), bookmark()),
    true,
  );
  // 100 + (140 - 0) - 24 = 216
  assert.equal(scroller.scrollTop, 216);
});

test("a bookmark whose row is above the mounted window falls back to its offset", () => {
  const scroller = fakeScroller({ scrollTop: 0, top: 0 });
  const content = fakeContent({ row: null });
  assert.equal(
    restoreTranscriptReadingPosition(scroller, content, bookmark({ scrollTop: 480 })),
    true,
    "a missing row with a usable offset must still restore",
  );
  assert.equal(scroller.scrollTop, 480);
});

test("a row that is mounted but has no height is treated as missing", () => {
  const scroller = fakeScroller({ scrollTop: 0, top: 0 });
  const collapsed = {
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0, left: 0, right: 800 }),
    offsetHeight: 0,
  };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row: collapsed }), bookmark({ scrollTop: 300 })),
    true,
  );
  assert.equal(scroller.scrollTop, 300);
});

test("a bookmark without a usable offset still reports failure", () => {
  const scroller = fakeScroller();
  const content = fakeContent({ row: null });
  for (const scrollTop of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(
      restoreTranscriptReadingPosition(scroller, content, bookmark({ scrollTop })),
      false,
      `scrollTop ${scrollTop} must not be applied`,
    );
  }
});

test("a pane with no layout is still refused outright", () => {
  // A hidden pane reports no box; applying any offset there would corrupt the
  // bookmark it is supposed to protect.
  const scroller = { scrollTop: 0, clientHeight: 0, scrollHeight: 0, offsetHeight: 0, getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row: null }), bookmark()),
    false,
  );
});
