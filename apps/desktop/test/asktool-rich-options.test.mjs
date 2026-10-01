import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  askToolOptionDescription,
  askToolOptionLabel,
  normalizeAskToolOption,
} from "../../../packages/shared/src/types/agent.ts";
import { AskToolRichText } from "../src/components/AskToolRichText.ts";

const richTextSource = await readFile(
  new URL("../src/components/AskToolRichText.ts", import.meta.url),
  "utf8",
);
const cardSource = await readFile(
  new URL("../src/components/AskToolCard.tsx", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);

test("asktool keeps legacy strings and normalizes rich labels and descriptions", () => {
  const legacy = normalizeAskToolOption("  Web  ");
  const rich = normalizeAskToolOption({
    label: "  Desktop  ",
    description: "  Installed on your computer.  ",
  });
  assert.equal(legacy, "Web");
  assert.deepEqual(rich, {
    label: "Desktop",
    description: "Installed on your computer.",
  });
  assert.equal(normalizeAskToolOption({ label: "  " }), undefined);
  assert.equal(askToolOptionLabel(rich), "Desktop");
  assert.equal(askToolOptionDescription(rich), "Installed on your computer.");
  assert.equal(askToolOptionDescription(legacy), undefined);
});

test("asktool renders rich question and option content while keeping label answers intact", () => {
  assert.match(cardSource, /<AskToolRichText source=\{current\.question\} \/>/);
  assert.match(cardSource, /<AskToolRichText source=\{label\} \/>/);
  assert.match(cardSource, /<span className="asktool-option-description">\{description\}<\/span>/);
  assert.doesNotMatch(cardSource, /<AskToolRichText source=\{description\}/);
  assert.match(cardSource, /onClick=\{\(\) => selectOption\(label\)\}/);
  assert.match(richTextSource, /remarkPlugins: \[remarkGfm\]/);
  assert.match(styleSource, /\.asktool-rich-code\s*\{/);

  const html = renderToStaticMarkup(
    createElement(AskToolRichText, {
      source:
        "**Bold** and *italic*, ~~removed~~, `code`, and\n\n- one\n- two\n\n1. first\n2. second",
    }),
  );
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>removed<\/del>/);
  assert.match(html, /<code[^>]*>code<\/code>/);
  assert.match(html, /role="list"/);
  assert.match(html, /asktool-rich-list-ordered/);
});

test("asktool rich content never creates live links, images, or raw HTML", () => {
  const html = renderToStaticMarkup(
    createElement(AskToolRichText, {
      source:
        "[Open](https://example.invalid) ![diagram](https://example.invalid/x.png)\n\n<script>alert(1)</script>",
    }),
  );
  assert.match(html, /Open/);
  assert.match(html, /diagram/);
  assert.doesNotMatch(html, /<a\b|<img\b|<script\b|href=|src=/i);
});
