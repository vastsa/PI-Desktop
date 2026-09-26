import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import test from "node:test";
import { unified } from "unified";
import { remarkNormalizeWrappedMarkdownLinkDestinations } from "../src/lib/markdown-link-destinations.ts";

const markdownSource = await readFile(
  new URL("../src/components/Markdown.tsx", import.meta.url),
  "utf8",
);

function collectLinks(node, links = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectLinks(child, links);
  } else if (node && typeof node === "object") {
    if (node.type === "link") links.push(node.url);
    collectLinks(node.children, links);
  }
  return links;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkNormalizeWrappedMarkdownLinkDestinations);

test("wrapped linked-host HTTP destinations become clickable HTTP links", () => {
  const source = [
    "[#1106](([github.com](https://github.com/vastsa/PI-Desktop/issues/1106)))",
    "[#1107](([github.com](https://github.com/vastsa/PI-Desktop/issues/1107)))",
  ].join("\n");
  const tree = processor.runSync(processor.parse(source));

  assert.deepEqual(collectLinks(tree), [
    "https://github.com/vastsa/PI-Desktop/issues/1106",
    "https://github.com/vastsa/PI-Desktop/issues/1107",
  ]);
});

test("ordinary links and non-HTTP destinations are not rewritten", () => {
  const tree = {
    type: "root",
    children: [
      { type: "link", url: "https://example.com/issue", children: [] },
      { type: "link", url: "([site](javascript:alert(1)))", children: [] },
      { type: "link", url: "([site](file:///tmp/issue))", children: [] },
    ],
  };
  processor.runSync(tree);

  assert.deepEqual(collectLinks(tree), [
    "https://example.com/issue",
    "([site](javascript:alert(1)))",
    "([site](file:///tmp/issue))",
  ]);
});

test("Markdown installs the normalizer before the rehype sanitizer", () => {
  assert.match(
    markdownSource,
    /staticRemarkPlugins\s*=\s*\[[\s\S]*?remarkNormalizeWrappedMarkdownLinkDestinations/,
  );
});
