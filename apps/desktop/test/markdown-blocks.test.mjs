import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceMarkdownBlocks,
  emptyMarkdownBlockCache,
  parseMarkdownBlocks,
} from "../src/lib/markdown-blocks.ts";

const blocksOf = (source) => parseMarkdownBlocks(source).blocks;

/** Feed `source` one appended chunk at a time, as streaming does. */
function stream(...chunks) {
  let cache = emptyMarkdownBlockCache;
  let source = "";
  for (const chunk of chunks) {
    source += chunk;
    cache = advanceMarkdownBlocks(cache, source);
  }
  return cache;
}

test("math bodies are indivisible blocks, including Markdown-looking lines", () => {
  for (const body of ["- x", "+ x", "* x", "> x", "x\n=\ny", "x\n\n+ y"]) {
    const math = `$$\n${body}\n$$\n\n`;
    assert.deepEqual(blocksOf(`Before.\n\n${math}After.`), [
      "Before.\n\n", math, "After.",
    ]);
  }
});

test("source slices preserve CRLF, leading whitespace and ordinary block boundaries", () => {
  const blocks = [
    "\r\nBefore.\r\n\r\n",
    "$$\r\n- x\r\n\r\n+ y\r\n$$\r\n\r\n",
    "- first\r\n- second\r\n\r\n",
    "> quote\r\n\r\n",
    "```text\r\n$$\r\n- literal\r\n$$\r\n```\r\n\r\n",
    "| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\n",
    "After.",
  ];
  assert.deepEqual(blocksOf(blocks.join("")), blocks);
  assert.deepEqual(blocksOf(" \r\n\r\n"), [" \r\n\r\n"]);
  assert.deepEqual(blocksOf(""), []);
});

test("an indented block keeps its own indentation in its own slice", () => {
  // Cutting at the node's first character instead of at its line start leaves
  // the indentation on the previous slice, and the block then re-parses as a
  // different one on its own: a nested list, or a fence that keeps the indent
  // inside its code.
  assert.deepEqual(blocksOf("Before.\n\n  - first\n  - second\n\nAfter."), [
    "Before.\n\n",
    "  - first\n  - second\n\n",
    "After.",
  ]);
  assert.deepEqual(blocksOf("Before.\n\n   1. one\n   1. two\n"), [
    "Before.\n\n",
    "   1. one\n   1. two\n",
  ]);
  assert.deepEqual(
    blocksOf("Before.\r\n\r\n  ```js\r\n  code\r\n  ```\r\n\r\nAfter."),
    ["Before.\r\n\r\n", "  ```js\r\n  code\r\n  ```\r\n\r\n", "After."],
  );
});

test("an unclosed math fence retains its whole body in the streaming tail", () => {
  for (const tail of ["$$\n- x", "$$\n- x\n\n+ y", "$$\n- x\n\n+ y\n$$"]) {
    assert.deepEqual(blocksOf(`Before.\n\n${tail}`), ["Before.\n\n", tail]);
  }
});

test("a definition anywhere makes the source one parse context", () => {
  for (const source of [
    "Text[^1].\n[^1]: footnote\n",
    "Text[^1].\n\n[^1]: footnote\n",
    "A[^1] and B[^1] reuse one note.\n\n[^1]: footnote\n",
    "[^1]: footnote\n\nText[^1].\n",
    "See [spec].\n\n[spec]: https://example.com\n",
    "> [spec]: https://example.com\n\nSee [spec].\n",
    "- [spec]: https://example.com\n\nSee [spec].\n",
  ]) {
    assert.equal(parseMarkdownBlocks(source).hasDocumentScopedDefinition, true, source);
    assert.deepEqual(advanceMarkdownBlocks(emptyMarkdownBlockCache, source).blocks, [source]);
  }
});

test("sources without definitions keep splitting into independent blocks", () => {
  for (const source of [
    "Before.\n\n$$\nx\n$$\n\nAfter.",
    "Text[^1] whose note never arrives.\n\nNext paragraph.\n",
    "See [spec] with no target.\n\nNext paragraph.\n",
    "```text\n[^1]: fenced, not a definition\n```\n\nAfter.\n",
  ]) {
    assert.equal(parseMarkdownBlocks(source).hasDocumentScopedDefinition, false, source);
    assert.ok(advanceMarkdownBlocks(emptyMarkdownBlockCache, source).blocks.length > 1, source);
  }
});

test("a definition streamed in after its reference still collapses the prefix", () => {
  const cache = stream("Text[^1].\n", "\nMore prose.\n", "\n[^1]: footnote\n");
  assert.equal(cache.singleUnit, true);
  assert.deepEqual(cache.blocks, ["Text[^1].\n\nMore prose.\n\n[^1]: footnote\n"]);
  // The latch holds without re-parsing once later text arrives.
  const later = advanceMarkdownBlocks(cache, `${cache.consumed}\nTail.\n`);
  assert.deepEqual(later.blocks, [later.consumed]);
});

test("streaming an appended source splits it exactly like one full parse", () => {
  const source = "Before.\n\n$$\n- x\n$$\n\n- first\n- second\n\nAfter.";
  for (let cut = 1; cut < source.length; cut++) {
    const cache = stream(source.slice(0, cut), source.slice(cut));
    assert.deepEqual(cache.blocks, blocksOf(source), `cut at ${cut}`);
  }
});

test("a source that stops extending the cached one is re-decided from scratch", () => {
  const withDefinition = stream("See [spec].\n\n[spec]: https://example.com\n");
  assert.equal(withDefinition.singleUnit, true);
  const replaced = advanceMarkdownBlocks(withDefinition, "Before.\n\nAfter.\n");
  assert.equal(replaced.singleUnit, false);
  assert.deepEqual(replaced.blocks, ["Before.\n\n", "After.\n"]);
});
