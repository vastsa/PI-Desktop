import { readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import {
  isClosedFencedCodeBlock,
  MAX_MERMAID_SOURCE_LENGTH,
  MermaidSourceTooLargeError,
  renderMermaidSvg,
} from "../src/lib/mermaid.ts";

const markdownSource = await readFile(
  new URL("../src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const mermaidSource = await readFile(
  new URL("../src/lib/mermaid.ts", import.meta.url),
  "utf8",
);
const transcriptSource = await readTranscriptSource();
const stylesSource = await loadStyles();

test("closed fence detection waits for the complete streamed block", () => {
  assert.equal(
    isClosedFencedCodeBlock("```mermaid\nflowchart LR\n  A --> B\n"),
    false,
  );
  assert.equal(
    isClosedFencedCodeBlock("```mermaid\nflowchart LR\n  A --> B\n```\n"),
    true,
  );
  assert.equal(
    isClosedFencedCodeBlock("~~~mermaid\nsequenceDiagram\n  A->>B: Hi\n~~~~\n\n"),
    true,
  );
  assert.equal(
    isClosedFencedCodeBlock("````mermaid\nA```B\n```\n"),
    false,
  );
  assert.equal(isClosedFencedCodeBlock("plain markdown"), false);
});

test("oversized diagrams fail before loading the browser renderer", async () => {
  await assert.rejects(
    renderMermaidSvg({
      id: "too-large",
      source: "x".repeat(MAX_MERMAID_SOURCE_LENGTH + 1),
      theme: "dark",
    }),
    MermaidSourceTooLargeError,
  );
});

test("assistant markdown lazily renders only completed mermaid fences", () => {
  assert.match(markdownSource, /info\.lang\.toLowerCase\(\) === "mermaid"/);
  assert.match(markdownSource, /closedFence/);
  assert.match(markdownSource, /IntersectionObserver/);
  assert.match(markdownSource, /rootMargin: "240px 0px"/);
  assert.match(markdownSource, /renderMermaidSvg/);
  assert.match(markdownSource, /dangerouslySetInnerHTML=\{\{ __html: svg \}\}/);
  assert.match(
    transcriptSource,
    /<Markdown source=\{text\} renderDiagrams=\{false\} \/>/,
  );
});

test("mermaid output keeps strict configuration and a second SVG sanitizer", () => {
  assert.match(mermaidSource, /import\("mermaid"\)/);
  assert.match(mermaidSource, /import\("dompurify"\)/);
  assert.match(mermaidSource, /securityLevel: "strict"/);
  assert.match(mermaidSource, /htmlLabels: false/);
  assert.match(mermaidSource, /maxTextSize: MAX_MERMAID_SOURCE_LENGTH/);
  assert.match(mermaidSource, /maxEdges: MAX_MERMAID_EDGES/);
  assert.match(mermaidSource, /USE_PROFILES: \{ svg: true, svgFilters: true \}/);
  assert.match(mermaidSource, /"foreignObject"/);
  assert.match(mermaidSource, /FORBID_ATTR: \["href", "target", "xlink:href"\]/);
});

test("diagram chrome is bounded, theme-aware, and reduced-motion safe", () => {
  assert.match(stylesSource, /\.mermaid-block\s*\{/);
  assert.match(stylesSource, /\.mermaid-svg\s*\{[\s\S]*?overflow: auto/);
  assert.match(
    stylesSource,
    /\.mermaid-svg > svg\s*\{[\s\S]*?width: 100%;[\s\S]*?max-width: 100%/,
  );
  // The diagram canvas is a token in both palettes (issue #341): light used to
  // pin #ffffff in a `:root[data-theme="light"]` override, which out-specified
  // the base rule and skipped the variable.
  assert.match(stylesSource, /\.mermaid-block-body\s*\{[^}]*background:\s*var\(--ds-mermaid-canvas\)/);
  assert.equal((stylesSource.match(/^\s*--ds-mermaid-canvas:/gm) ?? []).length, 2);
  assert.doesNotMatch(stylesSource, /:root\[data-theme="light"\] \.mermaid-block-body/);
  assert.match(
    stylesSource,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.mermaid-loading > span/,
  );
});
