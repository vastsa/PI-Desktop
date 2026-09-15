import { readTranscriptSource, readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SELECTION_QUOTE_GAP,
  SELECTION_QUOTE_MARGIN,
  codeFenceFor,
  intersectSelectionQuoteRect,
  normalizeSelectionMarkdown,
  placeSelectionQuote,
} from "../src/lib/selection-quote.ts";

const source = await readFile(
  new URL("../src/lib/selection-quote.ts", import.meta.url),
  "utf8",
);
const overlay = await readFile(
  new URL("../src/components/SelectionQuoteButton.tsx", import.meta.url),
  "utf8",
);
const transcript = await readTranscriptSource();
const composer = await readComposerSource();
const styles = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

test("a fence outgrows the backticks inside the quoted snippet", () => {
  assert.equal(codeFenceFor("plain"), "```");
  assert.equal(codeFenceFor("a ``` fence"), "````");
  assert.equal(codeFenceFor("inline", 1), "`");
  assert.equal(codeFenceFor("a `b` c", 1), "``");
});

test("rendered whitespace collapses back to source-like text", () => {
  assert.equal(normalizeSelectionMarkdown("  a\r\n b \r\n"), "a\n b");
  assert.equal(normalizeSelectionMarkdown("a\u00a0b"), "a b");
  assert.equal(normalizeSelectionMarkdown("a\n\n\n\nb"), "a\n\nb");
  assert.equal(normalizeSelectionMarkdown("\n  \n"), "");
});

test("a selection scrolled half out of its container anchors to what is visible", () => {
  const bounds = { left: 0, top: 100, right: 400, bottom: 300 };
  assert.deepEqual(intersectSelectionQuoteRect(rect(50, 120, 100, 20), bounds), {
    left: 50,
    top: 120,
    right: 150,
    bottom: 140,
    width: 100,
    height: 20,
  });
  // Partially scrolled out: only the visible strip is left.
  assert.deepEqual(intersectSelectionQuoteRect(rect(50, 80, 100, 40), bounds), {
    left: 50,
    top: 100,
    right: 150,
    bottom: 120,
    width: 100,
    height: 20,
  });
  assert.equal(intersectSelectionQuoteRect(rect(50, 40, 100, 20), bounds), null);
});

test("the overlay floats above the selection, centered on it", () => {
  const placement = placeSelectionQuote({
    anchor: rect(100, 200, 120, 20),
    size: { width: 200, height: 30 },
    bounds: { left: 0, top: 0, right: 800, bottom: 600 },
  });
  assert.deepEqual(placement, {
    top: 200 - SELECTION_QUOTE_GAP - 30,
    left: 160 - 100,
    maxWidth: 800 - SELECTION_QUOTE_MARGIN * 2,
  });
});

test("the overlay is clamped into its bounds on both axes", () => {
  const bounds = { left: 40, top: 100, right: 360, bottom: 300 };
  // A selection against the right edge slides left instead of escaping.
  const atRight = placeSelectionQuote({
    anchor: rect(340, 200, 20, 20),
    size: { width: 200, height: 30 },
    bounds,
  });
  assert.equal(atRight.left, bounds.right - SELECTION_QUOTE_MARGIN - 200);
  assert.ok(atRight.left + 200 <= bounds.right - SELECTION_QUOTE_MARGIN);

  // A selection at the top of the bounds keeps the pill inside them.
  const atTop = placeSelectionQuote({
    anchor: rect(100, 102, 100, 20),
    size: { width: 200, height: 30 },
    bounds,
  });
  assert.equal(atTop.top, bounds.top + SELECTION_QUOTE_MARGIN);

  // Bounds narrower than the pill cap its width instead of overflowing.
  const narrow = placeSelectionQuote({
    anchor: rect(40, 200, 20, 20),
    size: { width: 200, height: 30 },
    bounds: { left: 0, top: 0, right: 150, bottom: 300 },
  });
  assert.equal(narrow.maxWidth, 150 - SELECTION_QUOTE_MARGIN * 2);
  assert.equal(narrow.left, SELECTION_QUOTE_MARGIN);
});

test("the bounds are the scroll container, capped above the docked composer", () => {
  // The composer floats over the transcript, so the scroller's own bottom is not
  // the visible bottom (D-LOCAL-selection-overlay).
  assert.match(source, /export const COMPOSER_DOCK_SELECTOR = '\[data-composer-dock="docked"\]'/);
  assert.match(source, /bottomBoundaryTop/);
  assert.match(composer, /data-composer-dock=\{variant\}/);
  // Every clipping ancestor counts, as in the reference overlay.
  assert.match(source, /new Set\(\["auto", "clip", "hidden", "overlay", "scroll"\]\)/);
  assert.match(source, /style\?\.overflowY/);
  assert.match(source, /node = node\.parentElement/);
});

test("the pill only owns a selection that lives in one row of one transcript", () => {
  assert.match(source, /startRow !== quotableRowFor\(live\.endContainer\)/);
  assert.match(source, /if \(!scrollRoot\.contains\(startRow\)\) return null/);
  // A drag that leaves the row is clamped back to it instead of quoting the
  // next row.
  assert.match(source, /clamped\.compareBoundaryPoints\(Range\.START_TO_START, contents\) < 0/);
  assert.match(source, /clamped\.compareBoundaryPoints\(Range\.END_TO_END, contents\) > 0/);
});

test("a formula quotes as TeX instead of two duplicated renderings", () => {
  // KaTeX's source lives in the MathML annotation; the visual tree is a copy.
  assert.match(source, /annotation\[encoding="application\/x-tex"\]/);
  assert.match(
    source,
    /replaceWithText\(katex, isDisplay \? `\\n\$\$\\n\$\{tex\}\\n\$\$\\n` : `\$\$\{tex\}\$`, doc\)/,
  );
  assert.match(source, /closest\("\.katex-display"\)/);
  // A partial selection is expanded to the whole formula before cloning.
  assert.match(source, /setStartBefore\(start\)/);
  assert.match(source, /wrapper\.append\(expandRangeToWholeKatex\(range\)\.cloneContents\(\)\)/);
});

test("a quoted table keeps one line per row and a fence keeps its language", () => {
  assert.match(source, /querySelectorAll\(":scope > th, :scope > td"\)/);
  assert.match(source, /\.join\(" \| "\)/);
  assert.match(source, /querySelectorAll\("\.code-block"\)/);
  assert.match(source, /querySelector\("\.code-block-lang"\)/);
  assert.match(source, /querySelector\("pre code"\)/);
});

test("quote chrome is dropped but file-reference chips keep their text", () => {
  assert.match(source, /\.message-actions/);
  assert.match(source, /button\.replaceWith\(\.\.\.Array\.from\(button\.childNodes\)\)/);
  assert.doesNotMatch(source, /querySelectorAll\("button"\)\)\s*\{\s*node\.remove/);
});

test("formulas and code are reduced before chrome is dropped", () => {
  const order = [
    "replaceKatex(wrapper, ownerDocument)",
    "replaceCodeBlocks(wrapper, ownerDocument)",
    "replaceInlineCode(wrapper, ownerDocument)",
    "removeChrome(wrapper)",
    "replaceTables(wrapper, ownerDocument)",
  ].map((step) => source.indexOf(step));
  assert.ok(order.every((index) => index > -1), "every reduction step is present");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps run in order");
});

test("the overlay follows the selection instead of disappearing on scroll", () => {
  assert.match(overlay, /document\.addEventListener\("selectionchange", schedule\)/);
  assert.match(overlay, /window\.addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/);
  assert.match(overlay, /if \(!row \|\| !\(node instanceof Node\) \|\| !node\.contains\(row\)\) return/);
  for (const event of ["dblclick", "keyup", "pointerup", "pointercancel", "resize"]) {
    assert.match(overlay, new RegExp(`addEventListener\\("${event}"`), event);
  }
  assert.match(overlay, /requestAnimationFrame\(sync\)/);
  // Pressing anywhere else is a new gesture: the pill waits for it to settle.
  assert.match(overlay, /pressedRef\.current = true/);
  assert.match(overlay, /if \(pressedRef\.current\) return/);
  assert.match(overlay, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("the overlay offers add to chat, ask in side chat, and copy", () => {
  assert.match(overlay, /quoteMessageIntoComposer\(\{ title, text: target\.markdown \}\)/);
  assert.match(overlay, /t\("chat\.addToChat"\)/);
  assert.match(overlay, /t\("chat\.askInSideChat"\)/);
  assert.match(overlay, /t\("chat\.copy"\)/);
  assert.match(overlay, /await openSideChat\(target\.rowAnchorId\)/);
  assert.match(overlay, /sendPrompt\(\s*target\.markdown,\s*\{ text: target\.markdown, fileReferences: \[\] \},\s*childSessionId,?\s*\)/);
  // The action consumes the selection, as in the reference overlay.
  assert.match(overlay, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  // And it never sends to the conversation being read.
  assert.doesNotMatch(overlay, /activeSessionId \?\s*await sendPrompt|sendPrompt\(target\.markdown, \{[^}]*\}\);/);
});

test("the transcript mounts the overlay and skips read-only projections", () => {
  assert.match(
    transcript,
    /transcriptReadOnly \|\| !paneVisible \? null : \(\s*<SelectionQuoteButton scrollRef=\{scrollRef\} title=\{sessionTitle\} \/>/,
  );
  // One recovery path: the row actions quote through the same serializer.
  assert.match(transcript, /selectionMarkdownWithinRow\(message\.id\)/);
  assert.match(transcript, /selectionMarkdownWithinRow\(entry\.anchorId\)/);
  assert.doesNotMatch(transcript, /selection\.toString\(\)/);
});

test("the pill is one rounded action row with hairline separators", () => {
  assert.match(styles, /\.selection-quote \{[\s\S]*?border-radius: var\(--radius-full\)/);
  assert.match(styles, /\.selection-quote-sep \{/);
  assert.match(styles, /\.selection-quote-action:disabled/);
});
