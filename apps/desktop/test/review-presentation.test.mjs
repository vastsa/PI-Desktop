import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

test("history option totals retain recorded values, including real zero counts", async t => {
  const ssr = await slotSsr(t);
  const { ReviewTurnOption } = await ssr.load("/src/components/workpanel/ReviewTurnOption.tsx");
  const html = ssr.render(createElement(ReviewTurnOption, { turn: { id: "u1", createdAt: "2026-10-31T00:00:00Z", additions: 10, deletions: 0 } }));
  assert.match(html, /review-turn-time/);
  assert.match(html, /diff-count-add">\+10/);
  assert.match(html, /diff-count-del">−0/);
  assert.ok(html.indexOf('review-turn-time') < html.indexOf('review-turn-counts'));
});

test("missing, unsafe or partial totals stay unknown rather than becoming fictional zeros", async t => {
  const ssr = await slotSsr(t);
  const { ReviewTurnOption } = await ssr.load("/src/components/workpanel/ReviewTurnOption.tsx");
  for (const totals of [{}, { additions: null, deletions: null }, { additions: 1 }, { additions: -1, deletions: 0 }, { additions: 0.5, deletions: 0 }, { additions: Number.MAX_SAFE_INTEGER + 1, deletions: 0 }]) {
    const html = ssr.render(createElement(ReviewTurnOption, { turn: { id: "u", createdAt: "", ...totals } }));
    assert.match(html, /review-turn-counts is-unknown/);
    assert.match(html, /Line counts unknown/);
    assert.doesNotMatch(html, /diff-count-add|diff-count-del/);
  }
});

test("review and turn summaries share compact decorative file-type glyphs", async t => {
  const ssr = await slotSsr(t);
  const { ReviewFileIcon } = await ssr.load("/src/components/ReviewFileIcon.tsx");
  for (const [path, kind] of [["docs/a.md", "markdown"], ["D:\\x\\data.JSON", "json"], ["a.py", "python"], ["src/review.rs", "code"], ["README", "document"]]) {
    const html = ssr.render(createElement(ReviewFileIcon, { path }));
    assert.match(html, new RegExp(`review-file-type is-${kind}`));
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /width="14" height="14"/);
  }
});
