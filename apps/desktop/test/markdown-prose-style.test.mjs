import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const stylesSource = await loadStyles();
const markdownSource = await readFile(
  new URL("../src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const shikiSource = await readFile(
  new URL("../src/lib/shiki.ts", import.meta.url),
  "utf8",
);

test("chat prose keeps a refined hierarchy and quieter chrome", () => {
  assert.match(stylesSource, /\.prose-chat\s*\{/);
  assert.match(stylesSource, /\.prose-chat h1\s*\{[\s\S]*?font-size:\s*var\(--text-xl\)/);
  assert.match(stylesSource, /\.prose-chat h2\s*\{[\s\S]*?font-size:\s*var\(--text-lg-plus\)/);
  // D297: a blockquote is a soft tile, not a rail; no prose block draws a stroke.
  assert.match(stylesSource, /\.prose-chat blockquote\s*\{[^}]*background:\s*var\(--ds-tile\)/);
  assert.doesNotMatch(stylesSource, /\.prose-chat blockquote\s*\{[^}]*border-left/);
  assert.match(stylesSource, /\.prose-chat hr\s*\{[^}]*height:\s*0/);
  assert.match(stylesSource, /\.prose-chat code\s*\{/);
  // Tables carry no shell or cell rules: header is the deep tile, body rows
  // alternate the faint tile, hover lifts a step.
  assert.match(stylesSource, /\.prose-chat \.table-wrap\s*\{/);
  assert.doesNotMatch(stylesSource, /\.prose-chat \.table-wrap\s*\{[^}]*border:/);
  assert.doesNotMatch(stylesSource, /\.prose-chat th,\s*\.prose-chat td\s*\{[^}]*border-bottom/);
  assert.match(stylesSource, /\.prose-chat th\s*\{[^}]*background:\s*var\(--ds-tile-deep\)/);
  assert.match(stylesSource, /\.prose-chat tbody tr:nth-child\(even\) td\s*\{[^}]*background:\s*var\(--ds-tile\)/);
  assert.match(stylesSource, /\.prose-chat tbody tr:hover td\s*\{[^}]*background:\s*var\(--ds-tile-hover\)/);
  assert.match(stylesSource, /\.code-block\s*\{[^}]*border-radius:\s*var\(--radius-md-plus\)/);
  assert.doesNotMatch(stylesSource, /\.code-block\s*\{[^}]*border:/);
  assert.doesNotMatch(stylesSource, /\.code-block-head\s*\{[^}]*border-bottom/);
  assert.match(stylesSource, /\.code-block-lang\s*\{[\s\S]*?font-family:\s*var\(--font-mono\)/);
  assert.match(stylesSource, /\.thinking-prose\s*\{[\s\S]*?font-size:\s*var\(--text-sm-plus\)/);
});

test("markdown renderer still streams by memoized blocks", () => {
  assert.match(markdownSource, /function useBlocks\(source: string\)/);
  assert.match(markdownSource, /const markdownComponents: Components =/);
  assert.match(markdownSource, /className="code-block"/);
  assert.match(markdownSource, /className="table-wrap"/);
});

test("code blocks use one-dark-pro with a single surface background", () => {
  assert.match(
    shikiSource,
    /export const THEMES = \{\s*light:\s*"one-light",\s*dark:\s*"one-dark-pro"\s*\}/,
  );
  assert.doesNotMatch(shikiSource, /github-light|github-dark/);

  // Outer card owns the one-dark / one-light editor bg once.
  assert.match(stylesSource, /\.code-block\s*\{[\s\S]*?--code-block-bg:\s*#282c34/);
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\] \.code-block\s*\{[\s\S]*?--code-block-bg:\s*#fafafa/,
  );

  // No nested wash on pre/code/token spans.
  assert.match(
    stylesSource,
    /\.prose-chat \.code-block pre\s*\{[\s\S]*?background:\s*transparent !important/,
  );
  assert.match(
    stylesSource,
    /\.prose-chat \.code-block pre code\s*\{[\s\S]*?background:\s*transparent !important/,
  );
  assert.match(
    stylesSource,
    /\.code-block pre,\s*\.code-block code,[\s\S]*?background-color:\s*transparent/,
  );

  // Header is transparent (no second plate).
  assert.match(
    stylesSource,
    /\.code-block-head\s*\{[\s\S]*?background:\s*transparent/,
  );
});

test("light theme markdown uses paper-quiet surfaces", () => {
  /*
    Each pattern stays inside one rule body with `[^}]*`. An unbounded `[\s\S]*?`
    would happily run past the closing brace and match a declaration from some
    later rule, so a stale assertion would keep passing after the CSS moved on.
  */
  // Links keep the underline from the base rule and only soften its colour here.
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\] \.prose-chat a\s*\{[^}]*text-decoration-color:\s*color-mix\(in oklab,\s*#1a1c1f 30%/,
  );
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\] \.prose-chat code\s*\{[^}]*background:\s*color-mix\(in oklab,\s*#1a1c1f 6%/,
  );
  // Blockquotes keep their muted ink in light; the tile fill comes from the
  // theme-agnostic base rule, so the override sets colour only (D297).
  const lightBlockquote = stylesSource.match(
    /:root\[data-theme="light"\] \.prose-chat blockquote\s*\{[^}]*\}/,
  );
  assert.ok(lightBlockquote, "light theme should still tune the blockquote ink");
  assert.match(lightBlockquote[0], /color:\s*color-mix\(in oklab,\s*#1a1c1f 72%/);
  assert.doesNotMatch(lightBlockquote[0], /border|background:/);
  // No light-only table shell: the tiles are tokens and need no override.
  assert.doesNotMatch(
    stylesSource,
    /:root\[data-theme="light"\] \.prose-chat \.table-wrap\s*\{/,
  );
});
