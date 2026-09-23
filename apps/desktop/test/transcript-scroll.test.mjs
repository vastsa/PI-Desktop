import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_REVEAL_THRESHOLD_PX,
  TRANSCRIPT_REPIN_THRESHOLD_PX,
  TRANSCRIPT_SCROLL_GESTURE_WINDOW_MS,
  isHistoryRevealPosition,
  isRecentScrollGesture,
  reduceTranscriptScroll,
  capturePrependAnchor,
  createTranscriptPrependController,
  prependAnchorShift,
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

function prependGeometry() {
  let scrollTop = 100;
  const layout = { viewportTop: 500, rowContentTop: 130, rounding: 0 };
  const row = {
    isConnected: true,
    getAttribute: () => null,
    closest: () => scroller,
    getBoundingClientRect: () => {
      const top = layout.viewportTop + layout.rowContentTop - scrollTop;
      return { top, bottom: top + 50 };
    },
  };
  const scroller = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value - layout.rounding, this.scrollHeight - this.clientHeight)); },
    scrollHeight: 1000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: layout.viewportTop }),
    querySelectorAll: () => [row],
    contains: (node) => node === row,
  };
  return { layout, row, scroller };
}

const messageIds = (...ids) => ids.map((id) => ({ id }));
const originalPage = messageIds("a", "b");
const olderPage = messageIds("older", "a", "b");
function prependFrame(messages = originalPage, overrides = {}) {
  return {
    messages, renderedMessages: messages,
    windowSize: 80, historyLength: messages.length, mountedCount: messages.length,
    ...overrides,
  };
}

function prependReader() {
  const geometry = prependGeometry();
  const controller = createTranscriptPrependController();
  controller.commit(prependFrame(), geometry.scroller, false);
  return { ...geometry, controller };
}

test("continued scrolling without insertion has zero prepend correction", () => {
  const { layout, row, scroller } = prependGeometry();
  const anchor = capturePrependAnchor(scroller);
  assert.equal(anchor.top, 30);
  assert.equal(anchor.scrollTop, 100);
  scroller.scrollTop = 40;
  assert.equal(prependAnchorShift(anchor, row.getBoundingClientRect().top - layout.viewportTop, scroller.scrollTop), 0);
});

test("a 200px prepend preserves the reader's 60px upward scroll", () => {
  const { controller, layout, row, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  scroller.scrollTop = 40;
  layout.rowContentTop += 200;
  // Moving the whole pane is not insertion inside it.
  layout.viewportTop += 25;
  controller.settle(request);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
  assert.equal(row.getBoundingClientRect().top - layout.viewportTop, 90);
});

test("the raw page cannot consume its capture before deferred rows commit", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  controller.settle(request);
  scroller.scrollTop = 40;
  assert.equal(controller.commit(prependFrame(olderPage, { renderedMessages: originalPage }), scroller, false), null);
  assert.equal(scroller.scrollTop, 40);
  assert.equal(controller.begin("page", scroller), null, "one read owns the pending deferred commit");
  layout.rowContentTop += 200;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null, "restore is consumed exactly once");
});

test("tail append and same-count updates do not consume a pending page capture", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  scroller.scrollTop = 40;
  scroller.scrollHeight += 600;
  assert.equal(controller.commit(prependFrame(messageIds("a", "b", "tail")), scroller, false), null);
  assert.equal(controller.commit(prependFrame(messageIds("a", "edited")), scroller, false), null);
  assert.equal(controller.commit(prependFrame(messageIds("older", "a")), scroller, false), null, "same count is not a page prepend");
  assert.equal(scroller.scrollTop, 40);
  controller.settle(request);
  layout.rowContentTop += 200;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
});

test("a mounted page can precede promise completion without restoring twice or sticking loading", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  layout.rowContentTop += 200;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 300);
  assert.equal(controller.loading, true);
  assert.equal(controller.settle(request), true);
  assert.equal(controller.loading, false);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
  assert.ok(controller.begin("page", scroller));
});

test("a no-op completed read retires its capture before unrelated updates", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  controller.settle(request);
  assert.equal(controller.commit(prependFrame(), scroller, false), null);
  assert.equal(controller.loading, false);
  assert.equal(controller.begin("page", scroller), null, "the observer cannot loop on the same empty edge");
  scroller.scrollTop = 40;
  layout.rowContentTop += 200;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
  assert.equal(scroller.scrollTop, 40);
  assert.ok(controller.begin("page", scroller));
});

test("rejected reads release capture and duplicate in-flight reads are refused", async () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  assert.equal(controller.begin("page", scroller), null);
  assert.equal(controller.begin("window", scroller), null);
  await Promise.reject(new Error("read failed")).catch(() => controller.settle(request, true));
  assert.equal(controller.loading, false);
  layout.rowContentTop += 200;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
  assert.equal(scroller.scrollTop, 100);
});

test("navigation cancellation makes a stale promise unable to finish a later request", () => {
  const { controller, layout, scroller } = prependReader();
  const obsolete = controller.begin("page", scroller);
  controller.cancel();
  scroller.scrollTop = 40;
  const current = controller.begin("page", scroller);
  assert.equal(controller.settle(obsolete), false);
  assert.equal(controller.settle(obsolete, true), false);
  assert.equal(controller.loading, true);
  layout.rowContentTop += 200;
  controller.settle(current);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
});

test("cancellation drops obsolete geometry, while an explicit retry releases a failed edge", () => {
  const { controller, layout, scroller } = prependReader();
  const rejected = controller.begin("page", scroller);
  controller.settle(rejected, true);
  assert.equal(controller.begin("page", scroller), null);
  const retry = controller.begin("page", scroller, true);
  assert.ok(retry);
  controller.cancel();
  layout.rowContentTop += 200;
  assert.equal(controller.settle(retry), false);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
  assert.equal(scroller.scrollTop, 100);
});

test("a page outside the mounted window waits for local growth without counting the tail", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  controller.settle(request);
  scroller.scrollTop = 40;
  scroller.scrollHeight += 600; // a concurrent tail append, not mounted older rows
  const loaded = prependFrame(olderPage, { mountedCount: 2, historyLength: 100 });
  assert.equal(controller.commit(loaded, scroller, false), 40);
  assert.ok(controller.begin("window", scroller));
  assert.equal(controller.commit(loaded, scroller, false), null, "the state request alone is not a DOM commit");
  scroller.scrollTop = 20;
  layout.rowContentTop += 200;
  const mounted = { ...loaded, windowSize: 100, mountedCount: 100 };
  assert.equal(controller.commit(mounted, scroller, false), 220);
});

test("local growth without additional mounted rows retires the capture without scrolling", () => {
  const { controller, layout, scroller } = prependReader();
  assert.ok(controller.begin("window", scroller));
  layout.rowContentTop += 50;
  assert.equal(controller.commit(prependFrame(originalPage, { windowSize: 100 }), scroller, false), null);
  assert.equal(scroller.scrollTop, 100);
  assert.ok(controller.begin("page", scroller));
});

test("underfilled auto-paging retains bottom ownership after insertion starts overflowing", () => {
  const { controller, layout, scroller } = prependReader();
  scroller.scrollHeight = 400;
  scroller.scrollTop = 0;
  assert.equal(isHistoryRevealPosition(scroller, true), true);
  const request = controller.begin("page", scroller);
  controller.settle(request);
  layout.rowContentTop += 500;
  scroller.scrollHeight = 900;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, true), 400);
  assert.equal(isHistoryRevealPosition(scroller, true), false);
});

test("correction records the achieved fractional scrollTop, not the intended target", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  scroller.scrollTop = 40;
  layout.rowContentTop += 200;
  layout.rounding = 0.25;
  controller.settle(request);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 239.75);
});

test("a removed reading row never falls back to a possibly unrelated tail height delta", () => {
  const { controller, row, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  controller.settle(request);
  row.isConnected = false;
  scroller.scrollHeight += 2000;
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 100);
});

test("a regrouped turn restores its remounted message by stable identity", () => {
  const { controller, layout, row, scroller } = prependReader();
  row.getAttribute = () => "a";
  const request = controller.begin("page", scroller);
  scroller.scrollTop = 40;
  row.isConnected = false;
  const replacement = { ...row, isConnected: true };
  scroller.querySelectorAll = () => [replacement];
  scroller.contains = (node) => node === replacement;
  layout.rowContentTop += 200;
  controller.settle(request);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
});

test("a nested scroller's row cannot become the outer prepend anchor", () => {
  const { row, scroller } = prependGeometry();
  const nestedRow = { ...row, closest: () => ({}) };
  scroller.querySelectorAll = () => [nestedRow, row];
  assert.equal(capturePrependAnchor(scroller).node, row);
});

test("a page committed while hidden keeps its capture until the pane is laid out", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  // The reader moved after capture; reveal restores that last visible offset.
  scroller.scrollTop = 40;
  layout.rowContentTop += 200;
  assert.equal(controller.commit(prependFrame(olderPage), null, false), null);
  assert.equal(controller.settle(request), true);
  assert.equal(controller.begin("page", scroller), null, "reveal must not replace the existing read");
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
});

for (const outcome of ["no-op", "rejected"]) {
  test(`a ${outcome} read completed while hidden retires its capture`, async () => {
    const { controller, layout, scroller } = prependReader();
    const request = controller.begin("page", scroller);
    scroller.scrollTop = 40;
    assert.equal(controller.commit(prependFrame(), null, false), null);
    if (outcome === "rejected") {
      await Promise.reject(new Error("hidden read failed")).catch(() => controller.settle(request, true));
    } else {
      assert.equal(controller.settle(request), true);
    }
    assert.equal(controller.commit(prependFrame(), null, false), null);
    assert.equal(controller.loading, false);
    assert.equal(controller.begin("page", scroller), null, "reveal cannot retry the empty/failed edge automatically");
    // Reveal directly into an unrelated insertion, without an intervening
    // visible no-op commit that could mask failure to retire while hidden.
    layout.rowContentTop += 200;
    assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
    assert.equal(scroller.scrollTop, 40, "an unrelated later insertion cannot consume the hidden capture");
    assert.ok(controller.begin("page", scroller), "the changed edge can start a new read");
  });
}

test("navigation while hidden prevents a stale promise from owning the revealed request", async () => {
  const { controller, layout, scroller } = prependReader();
  const obsolete = controller.begin("page", scroller);
  let finishObsolete;
  const stale = new Promise((resolve) => { finishObsolete = resolve; })
    .then(() => controller.settle(obsolete));
  scroller.scrollTop = 40;
  assert.equal(controller.commit(prependFrame(olderPage), null, false), null);
  assert.equal(controller.cancel(), true);
  const destination = messageIds("destination");
  assert.equal(controller.commit(prependFrame(destination), null, false), null);
  assert.equal(controller.commit(prependFrame(destination), scroller, false), null);
  const current = controller.begin("page", scroller);
  assert.ok(current);
  finishObsolete();
  assert.equal(await stale, false);
  assert.equal(controller.settle(obsolete, true), false, "a stale rejection cannot retire the new capture either");
  assert.equal(controller.loading, true);
  layout.rowContentTop += 200;
  assert.equal(controller.settle(current), true);
  assert.equal(controller.commit(prependFrame(messageIds("earlier-destination", "destination")), scroller, false), 240);
  assert.equal(controller.loading, false);
});

test("a disclosure hands its achieved position to the original pending page", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  layout.rowContentTop += 80; // disclosure changed the current reading geometry
  scroller.querySelectorAll = () => { throw new Error("handoff must not scan every mounted row"); };
  controller.reanchor(scroller);
  assert.equal(controller.begin("page", scroller), null, "the original read still owns paging");
  scroller.scrollTop = 40;
  layout.rowContentTop += 200;
  controller.settle(request);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 240);
});

test("a held disclosure can own insertion without a second prepend correction", () => {
  const { controller, layout, scroller } = prependReader();
  const request = controller.begin("page", scroller);
  layout.rowContentTop += 200;
  scroller.scrollTop = 300; // held-title restoration already positioned this commit
  controller.reanchor(scroller);
  controller.settle(request);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), 300);
  assert.equal(controller.commit(prependFrame(olderPage), scroller, false), null);
});
