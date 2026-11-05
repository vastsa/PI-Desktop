import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// `restoreTranscriptReadingPosition` escapes the id with the browser-only
// `CSS.escape`; this suite runs the function directly in Node.
globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
const { captureTranscriptReadingPosition, restoreTranscriptReadingPosition, isTranscriptReadingAnchorVisible } = await import(
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

test("unchanged/subpixel anchor alignment does not write scrollTop or stop native travel", () => {
  const scroller = fakeScroller({ scrollTop: 480 });
  let top = scroller.scrollTop;
  let writes = 0;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => top,
    set: value => { writes++; top = value; },
  });
  let rowTop = 24;
  const row = { getBoundingClientRect: () => ({ top: rowTop, height: 80 }) };
  const content = fakeContent({ row });
  assert.equal(restoreTranscriptReadingPosition(scroller, content, bookmark()), true);
  rowTop = 24.25;
  assert.equal(restoreTranscriptReadingPosition(scroller, content, bookmark()), true);
  assert.equal(writes, 0);
  rowTop = 144;
  restoreTranscriptReadingPosition(scroller, content, bookmark());
  assert.equal(writes, 1);
  assert.equal(top, 600);
  restoreTranscriptReadingPosition(scroller, fakeContent(), bookmark({ scrollTop: 600 }));
  assert.equal(writes, 1, "an unchanged missing-row fallback also leaves native travel alone");
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

test("capture anchors the visible message, not its regroupable answer wrapper", () => {
  const scroller = fakeScroller({ scrollTop: 80 });
  const row = (dataset, top, height) => ({
    dataset,
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  });
  const wrapper = row({ minimapId: "old-group" }, -400, 1600);
  const previous = row({ messageId: "above" }, -400, 350);
  const visible = row({ messageId: "visible" }, -20, 800);
  const content = {
    querySelectorAll: selector => selector === "[data-message-id]"
      ? [previous, visible] : selector === "[data-minimap-id]" ? [wrapper] : [wrapper, previous, visible],
  };
  const position = captureTranscriptReadingPosition(scroller, content, false, 60);
  assert.equal(position.messageId, "visible");
  assert.equal(position.offset, -20);
  // Prepending the preceding half changes the group key, not this message id.
  const moved = row({ messageId: "visible" }, 6400, 800);
  assert.equal(restoreTranscriptReadingPosition(scroller, fakeContent({ row: moved }), position), true);
  assert.equal(scroller.scrollTop, 6500);
});

test("capture retains a turn anchor when no visible message body is mounted", () => {
  const scroller = fakeScroller();
  const wrapper = { dataset: { minimapId: "tools-only" },
    getBoundingClientRect: () => ({ top: -20, bottom: 800, height: 820 }) };
  const content = { querySelectorAll: selector => selector === "[data-message-id]" ? [] : [wrapper] };
  assert.equal(captureTranscriptReadingPosition(scroller, content, false, 60).messageId, "tools-only");
});

test("restore prefers the actual message over a group with the same marker id", () => {
  const scroller = fakeScroller({ scrollTop: 80 });
  const content = { querySelector: selector => ({
    getBoundingClientRect: () => ({ top: selector.startsWith("[data-message-id=") ? 140 : 100, height: 600 }),
  }) };
  assert.equal(restoreTranscriptReadingPosition(scroller, content, bookmark({ offset: 20 })), true);
  assert.equal(scroller.scrollTop, 200);
});

test("anchor visibility uses its intended offset, not displacement from a lazy predecessor", () => {
  const scroller = fakeScroller();
  const row = { getBoundingClientRect: () => ({ top: 900, height: 800 }) };
  assert.equal(isTranscriptReadingAnchorVisible(scroller, fakeContent({ row }), bookmark({ offset: 77 })), true);
});

test("an anchor changes only after its full row leaves the intended viewport", () => {
  const scroller = fakeScroller();
  const row = { getBoundingClientRect: () => ({ top: 0, height: 800 }) };
  const content = fakeContent({ row });
  for (const [offset, visible] of [[599, true], [600, false], [-799, true], [-800, false]]) {
    assert.equal(isTranscriptReadingAnchorVisible(scroller, content, bookmark({ offset })), visible);
  }
  assert.equal(isTranscriptReadingAnchorVisible(scroller, fakeContent(), bookmark()), false);
  assert.equal(isTranscriptReadingAnchorVisible(scroller, content, bookmark({ messageId: undefined })), false);
  assert.equal(isTranscriptReadingAnchorVisible({ ...scroller, clientHeight: 0 }, content, bookmark()), false);
});
