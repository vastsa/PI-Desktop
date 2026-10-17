import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_PAGE_LIMIT,
  applyNextReviewPage,
  applyReviewPage,
  beginReviewLoad,
  beginReviewLoadMore,
  effectiveReviewUrl,
  failReviewLoad,
  formatRatingAvg,
  formatReviewRating,
  initialReviewListState,
  mergeReviews,
  nextSummaryMap,
  officialReviewUrl,
  reviewQuery,
  reviewQueryKey,
  sentimentShares,
} from "../src/features/plugins/reviews.ts";

function review(overrides = {}) {
  return {
    id: "r1",
    pluginId: "acme.todo",
    authorName: "Ada",
    ratingHalfStars: 9,
    body: "Works well.",
    status: "visible",
    pluginVersion: "1.2.0",
    helpfulCount: 2,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    editedAt: null,
    ...overrides,
  };
}

function summary(overrides = {}) {
  return {
    pluginId: "acme.todo",
    ratingAvg: 4.5,
    ratingCount: 3,
    ratingDist: [0, 0, 0, 1, 2],
    positiveCount: 2,
    neutralCount: 1,
    negativeCount: 0,
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    reviews: [review()],
    nextCursor: null,
    summary: summary(),
    reviewUrl: "https://plugins.aiuo.net/plugins/acme.todo#reviews",
    ...overrides,
  };
}

test("the official review URL encodes the plugin id into the fallback page", () => {
  assert.equal(
    officialReviewUrl("acme.todo"),
    "https://plugins.aiuo.net/plugins/acme.todo#reviews",
  );
  assert.equal(
    officialReviewUrl("a/b c#d"),
    "https://plugins.aiuo.net/plugins/a%2Fb%20c%23d#reviews",
  );
});

test("the page URL wins only when it is a usable http(s) address", () => {
  assert.equal(
    effectiveReviewUrl("acme.todo", " http://127.0.0.1:8787/plugins/acme.todo#reviews "),
    "http://127.0.0.1:8787/plugins/acme.todo#reviews",
  );
  for (const bad of [null, undefined, "", "   ", "javascript:alert(1)", "/relative", "data:text/plain"]) {
    assert.equal(
      effectiveReviewUrl("acme.todo", bad),
      "https://plugins.aiuo.net/plugins/acme.todo#reviews",
      `expected fallback for ${String(bad)}`,
    );
  }
});

test("one query key names exactly one plugin, sentiment and sort", () => {
  const a = reviewQueryKey("acme.todo", "all", "newest");
  assert.notEqual(a, reviewQueryKey("acme.todo", "positive", "newest"));
  assert.notEqual(a, reviewQueryKey("acme.todo", "all", "helpful"));
  assert.notEqual(a, reviewQueryKey("other.plugin", "all", "newest"));
  assert.equal(a, reviewQueryKey("acme.todo", "all", "newest"));
});

test("mergeReviews appends unseen rows once and keeps the shown order", () => {
  const first = review({ id: "r1" });
  const second = review({ id: "r2" });
  assert.deepEqual(
    mergeReviews([first], [first, second]).map((row) => row.id),
    ["r1", "r2"],
  );
  assert.deepEqual(
    mergeReviews([second], [first]).map((row) => row.id),
    ["r2", "r1"],
  );
  assert.deepEqual(mergeReviews([], []), []);
});

test("rating formatting follows the contract: one decimal, half stars trimmed", () => {
  assert.equal(formatRatingAvg(4.5, "en"), "4.5");
  assert.equal(formatRatingAvg(5, "en"), "5.0");
  assert.equal(formatRatingAvg(null, "en"), null);
  assert.equal(formatRatingAvg(undefined, "en"), null);
  assert.equal(formatRatingAvg(Number.NaN, "en"), null);

  assert.equal(formatReviewRating(9), "4.5");
  assert.equal(formatReviewRating(10), "5");
  assert.equal(formatReviewRating(2), "1");
  assert.equal(formatReviewRating(0), "0");
});

test("sentiment shares split the good / medium / bad counts into percentages", () => {
  const shares = sentimentShares(summary({ positiveCount: 2, neutralCount: 1, negativeCount: 0 }));
  assert.deepEqual(
    shares.map(({ key, count }) => [key, count]),
    [
      ["positive", 2],
      ["neutral", 1],
      ["negative", 0],
    ],
  );
  assert.deepEqual(
    shares.map(({ percent }) => percent),
    [67, 33, 0],
  );

  const empty = sentimentShares(null);
  assert.deepEqual(
    empty.map(({ count, percent }) => [count, percent]),
    [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  );
});

test("a query carries the page limit and only adds a cursor when paging", () => {
  assert.deepEqual(reviewQuery("acme.todo", "all", "newest"), {
    pluginId: "acme.todo",
    sentiment: "all",
    sort: "newest",
    limit: REVIEW_PAGE_LIMIT,
  });
  assert.deepEqual(reviewQuery("acme.todo", "negative", "helpful", "cursor-1"), {
    pluginId: "acme.todo",
    sentiment: "negative",
    sort: "helpful",
    limit: REVIEW_PAGE_LIMIT,
    cursor: "cursor-1",
  });
});

test("a first page fills the list and closes the load", () => {
  const key = reviewQueryKey("acme.todo", "all", "newest");
  const loading = beginReviewLoad(initialReviewListState(), key);
  assert.equal(loading.key, key);
  assert.equal(loading.status, "loading");

  const ready = applyReviewPage(loading, key, page({ nextCursor: "next-1" }), "acme.todo");
  assert.equal(ready.status, "ready");
  assert.equal(ready.error, null);
  assert.equal(ready.nextCursor, "next-1");
  assert.deepEqual(ready.reviews.map((row) => row.id), ["r1"]);
  assert.equal(ready.summary?.ratingAvg, 4.5);
  assert.equal(ready.reviewUrl, "https://plugins.aiuo.net/plugins/acme.todo#reviews");
});

test("a summary of zero reviews is carried through as zero, not as unavailable", () => {
  // The centre answers known plugins without reviews with a zero summary
  // (`ratingAvg: null`, `ratingCount: 0`); that is data the detail sheet can
  // show as "no reviews yet", which must stay distinct from "unavailable".
  const key = reviewQueryKey("acme.todo", "all", "newest");
  const zero = summary({
    ratingAvg: null,
    ratingCount: 0,
    ratingDist: [0, 0, 0, 0, 0],
    positiveCount: 0,
    neutralCount: 0,
    negativeCount: 0,
  });
  const state = applyReviewPage(
    beginReviewLoad(initialReviewListState(), key),
    key,
    page({ reviews: [], nextCursor: null, summary: zero }),
    "acme.todo",
  );
  assert.equal(state.status, "ready");
  assert.equal(state.summary?.ratingCount, 0);
  assert.equal(state.summary?.ratingAvg, null);
  assert.equal(formatRatingAvg(state.summary?.ratingAvg, "en"), null);
});

test("a summary answer replaces the requested ids, so an omitted id loses its rating", () => {
  // First batch: both ids answered.
  const first = nextSummaryMap(
    ["a.plugin", "b.plugin"],
    { "a.plugin": summary(), "b.plugin": summary({ pluginId: "b.plugin" }) },
  );
  assert.deepEqual(Object.keys(first).sort(), ["a.plugin", "b.plugin"]);

  // The centre deliberately omits an id it no longer serves (archived or
  // unpublished): the rating that was showing must go with it.
  const second = nextSummaryMap(["a.plugin", "b.plugin"], { "a.plugin": summary() });
  assert.deepEqual(Object.keys(second), ["a.plugin"]);

  // A key that was not requested never enters the map.
  const third = nextSummaryMap(
    ["a.plugin"],
    { "c.plugin": summary({ pluginId: "c.plugin" }) },
  );
  assert.deepEqual(third, {});

  // A requested id answered with a zero summary stays as zero, not missing.
  const zero = nextSummaryMap(
    ["a.plugin"],
    { "a.plugin": summary({ ratingAvg: null, ratingCount: 0 }) },
  );
  assert.equal(zero["a.plugin"]?.ratingCount, 0);
  assert.equal(zero["a.plugin"]?.ratingAvg, null);
});

test("a page that does not carry reviewUrl falls back to the official page", () => {
  // The host derives the trusted centre URL; until a host adds it, or if the
  // server page omits it, the write link still points somewhere real.
  const key = reviewQueryKey("acme.todo", "all", "newest");
  const state = applyReviewPage(
    beginReviewLoad(initialReviewListState(), key),
    key,
    page({ reviewUrl: undefined }),
    "acme.todo",
  );
  assert.equal(state.reviewUrl, "https://plugins.aiuo.net/plugins/acme.todo#reviews");
});

test("an answer for another query cannot reach the list on screen", () => {
  const keyA = reviewQueryKey("acme.todo", "all", "newest");
  const keyB = reviewQueryKey("acme.todo", "positive", "newest");
  const loadingB = beginReviewLoad(beginReviewLoad(initialReviewListState(), keyA), keyB);
  // The answer for A arrives while B owns the list: dropped entirely.
  const afterLateA = applyReviewPage(loadingB, keyA, page(), "acme.todo");
  assert.equal(afterLateA, loadingB);
  assert.deepEqual(afterLateA.reviews, []);
  assert.equal(afterLateA.status, "loading");
});

test("switching filter drops the old rows; retrying the same filter keeps them", () => {
  const keyA = reviewQueryKey("acme.todo", "all", "newest");
  const ready = applyReviewPage(
    beginReviewLoad(initialReviewListState(), keyA),
    keyA,
    page(),
    "acme.todo",
  );

  const switched = beginReviewLoad(ready, reviewQueryKey("acme.todo", "negative", "newest"));
  assert.deepEqual(switched.reviews, []);
  assert.equal(switched.status, "loading");
  assert.equal(switched.summary, null);

  const retried = beginReviewLoad(ready, keyA);
  assert.deepEqual(retried.reviews.map((row) => row.id), ["r1"]);
  assert.equal(retried.status, "ready");
  assert.equal(retried.error, null);
});

test("paging appends without repeating a row that moved between pages", () => {
  const key = reviewQueryKey("acme.todo", "all", "newest");
  let state = applyReviewPage(
    beginReviewLoad(initialReviewListState(), key),
    key,
    page({ reviews: [review({ id: "r1" }), review({ id: "r2" })], nextCursor: "next-1" }),
    "acme.todo",
  );
  state = beginReviewLoadMore(state);
  assert.equal(state.loadingMore, true);
  // The stable keyset cursor can hand back a row the user already saw when
  // the helpful order shifted; the id decides.
  state = applyNextReviewPage(
    state,
    key,
    page({ reviews: [review({ id: "r2" }), review({ id: "r3" })], nextCursor: null }),
  );
  assert.equal(state.loadingMore, false);
  assert.deepEqual(state.reviews.map((row) => row.id), ["r1", "r2", "r3"]);
  assert.equal(state.nextCursor, null);
});

test("a failure keeps readable rows and only replaces an empty list", () => {
  const key = reviewQueryKey("acme.todo", "all", "newest");
  const withRows = applyReviewPage(
    beginReviewLoad(initialReviewListState(), key),
    key,
    page(),
    "acme.todo",
  );
  const moreFailed = failReviewLoad(withRows, key, "boom");
  assert.equal(moreFailed.status, "ready");
  assert.equal(moreFailed.error, "boom");
  assert.deepEqual(moreFailed.reviews.map((row) => row.id), ["r1"]);

  const firstFailed = failReviewLoad(beginReviewLoad(initialReviewListState(), key), key, "boom");
  assert.equal(firstFailed.status, "error");
  assert.equal(firstFailed.error, "boom");
  assert.deepEqual(firstFailed.reviews, []);
});

test("a failure for a query that is no longer on screen is ignored", () => {
  const keyA = reviewQueryKey("acme.todo", "all", "newest");
  const keyB = reviewQueryKey("acme.todo", "helpful", "newest");
  const loadingB = beginReviewLoad(initialReviewListState(), keyB);
  assert.equal(failReviewLoad(loadingB, keyA, "boom"), loadingB);
});
