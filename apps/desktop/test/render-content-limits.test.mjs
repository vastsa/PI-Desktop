import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectHighlightLimits,
  isWithinHighlightLimits,
  MAX_HIGHLIGHT_CODE_UNITS,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_CODE_UNITS,
  MAX_RENDERED_TEXT_PAGE_CODE_UNITS,
  renderedTextPage,
} from "../src/lib/render-content-limits.ts";

test("highlight boundaries are checked in UTF-16 units before splitting", () => {
  const maximumSource = ("x".repeat(999) + "\n").repeat(100);
  assert.equal(maximumSource.length, MAX_HIGHLIGHT_CODE_UNITS);
  assert.equal(isWithinHighlightLimits(maximumSource), true);
  assert.deepEqual(inspectHighlightLimits("x".repeat(MAX_HIGHLIGHT_CODE_UNITS + 1)), {
    within: false,
    lineCount: 0,
    longestLine: 0,
    reason: "code-length",
  });
  assert.equal(isWithinHighlightLimits("x".repeat(MAX_HIGHLIGHT_LINE_CODE_UNITS)), true);
  assert.equal(isWithinHighlightLimits("x".repeat(MAX_HIGHLIGHT_LINE_CODE_UNITS + 1)), false);
  assert.equal(isWithinHighlightLimits(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => "x").join("\n")), true);
  assert.equal(isWithinHighlightLimits(Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "x").join("\n")), false);
});

test("large text pages stay bounded and reconstruct the complete source", () => {
  const source = `start\n${"x".repeat(MAX_RENDERED_TEXT_PAGE_CODE_UNITS * 4)}\nend`;
  const first = renderedTextPage(source, 0);
  const latest = renderedTextPage(source, 0, true);
  assert.equal(first.index, 0);
  assert.equal(first.count, 5);
  assert.ok(first.text.length <= MAX_RENDERED_TEXT_PAGE_CODE_UNITS);
  assert.equal(latest.index, latest.count - 1);
  assert.ok(latest.text.endsWith("\nend"));
  assert.equal(renderedTextPage(source, Number.NaN).index, 0);
  assert.equal(
    Array.from({ length: first.count }, (_, index) => renderedTextPage(source, index).text).join(""),
    source,
  );
  assert.equal(renderedTextPage(source, Number.POSITIVE_INFINITY).index, first.count - 1);
});

test("large text page boundaries never split a surrogate pair", () => {
  const prefix = "x".repeat(MAX_RENDERED_TEXT_PAGE_CODE_UNITS - 1);
  const source = `${prefix}😀${"y".repeat(MAX_RENDERED_TEXT_PAGE_CODE_UNITS)}`;
  const pages = Array.from(
    { length: Math.ceil(source.length / MAX_RENDERED_TEXT_PAGE_CODE_UNITS) },
    (_, index) => renderedTextPage(source, index).text,
  );
  assert.equal(pages.join(""), source);
  assert.ok(pages.every((page) => !/^[\uDC00-\uDFFF]/.test(page)));
  assert.ok(pages.every((page) => !/[\uD800-\uDBFF]$/.test(page)));
});
