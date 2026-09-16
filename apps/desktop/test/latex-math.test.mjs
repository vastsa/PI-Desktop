import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import {
  normalizeLatexMathDelimiters,
  remarkLatexBracketDisplay,
} from "../src/lib/latex-math.ts";

test("normalizes TeX math delimiters without changing source length", () => {
  for (const [source, expected] of [
    [String.raw`before \(a+b\) after`, "before $$a+b$$ after"],
    [String.raw`\[
a+b
\]`, "$$\na+b\n$$"],
  ]) {
    const normalized = normalizeLatexMathDelimiters(source);
    assert.equal(normalized, expected);
    assert.equal(normalized.length, source.length);
  }
});

test("leaves escaped, unmatched, and code-delimited TeX markers literal", () => {
  for (const source of [
    String.raw`\\(escaped\\)`,
    String.raw`\(unmatched`,
    String.raw`__TICK__\(inline\)__TICK__`.replaceAll("__TICK__", "`"),
    "```tex\n\\(fenced\\)\n```",
    "~~~tex\n\\[fenced\\]\n~~~",
  ]) {
    assert.equal(normalizeLatexMathDelimiters(source), source);
  }
});

test("renders TeX parentheses inline and TeX brackets as KaTeX display math", () => {
  for (const [source, display] of [
    [String.raw`\(a+b\)`, false],
    [String.raw`\[a+b\]`, true],
  ]) {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [remarkMath, remarkLatexBracketDisplay(source)],
          rehypePlugins: [rehypeKatex],
        },
        normalizeLatexMathDelimiters(source),
      ),
    );
    assert.match(html, /class="katex"/);
    if (display) assert.match(html, /class="katex-display"/);
    else assert.doesNotMatch(html, /class="katex-display"/);
  }
});
