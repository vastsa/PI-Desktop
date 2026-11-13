import { register } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { advanceMarkdownBlocks, emptyMarkdownBlockCache, markdownRemarkPlugins } = await import("../src/lib/markdown-blocks.ts");

const render = source => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins, children: source }));

test("CJK emphasis preserves source offsets and streaming grammar at every prefix", () => {
  const phrase = '**“重点内容”**';
  const source = `😀这是${phrase}，请查看。\n\n后续**重点。**继续。`;
  assert.match(render(source), /<strong>“重点内容”<\/strong>/);
  assert.match(render(source), /<strong>重点。<\/strong>/);
  const root = unified().use(remarkParse).use(markdownRemarkPlugins).parse(source);
  const strong = root.children[0].children.find(node => node.type === "strong");
  assert.equal(source.slice(strong.position.start.offset, strong.position.end.offset), phrase);
  let cache = emptyMarkdownBlockCache;
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    cache = advanceMarkdownBlocks(cache, prefix);
    assert.equal(cache.blocks.join(""), prefix);
    assert.equal(cache.blocks.map(render).filter(Boolean).join("\n"), render(prefix), JSON.stringify(prefix));
  }
});

test("code, escapes, link destinations and English emphasis keep their grammar", () => {
  for (const source of ['这是`**“示例”**`。', '```text\n这是**“示例”**。\n```', '这是\\*\\*“示例”\\*\\*。', 'a**"example"**']) {
    assert.doesNotMatch(render(source), /<strong[ >]/);
  }
  const url = 'https://example.com/**“path”**';
  assert.ok(render(`[link](${url})`).includes(`href="${encodeURI(url)}"`));
  assert.match(render('**bold** and *italic*'), /<strong>bold<\/strong> and <em>italic<\/em>/);
});
