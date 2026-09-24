import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import { markdownTableData } from "../src/lib/markdown-table.ts";

function exportsOf(source) {
  const tables = [];
  renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [rehypeRaw, rehypeSanitize, rehypeKatex],
    components: { table({ node }) { tables.push(markdownTableData(node, source)); return null; } },
  }, source));
  return tables;
}

test("each table keeps its own Markdown formatting and column alignment", () => {
  const source = "Before\n\n| **Name** | Value |\n| :--- | ---: |\n| [Docs](https://example.com) | `a\\|b` |\n\nOther\n\n| Next |\n| --- |\n| 二 |";
  const [first, second] = exportsOf(source);
  assert.equal(first.markdown, "| **Name** | Value |\n| :--- | ---: |\n| [Docs](https://example.com) | `a\\|b` |");
  assert.equal(first.csv, '\uFEFF"Name","Value"\r\n"Docs","a|b"\r\n');
  assert.equal(second.markdown, "| Next |\n| --- |\n| 二 |");
  assert.equal(second.csv, '\uFEFF"Next"\r\n"二"\r\n');
});

test("quoted/list tables copy as standalone tables, including Windows line endings", () => {
  for (const source of [
    "> | A | B |\r\n> | --- | :---: |\r\n> | **one** | two |",
    "- Example\n\n  | A | B |\n  | --- | :---: |\n  | **one** | two |",
  ]) {
    assert.equal(exportsOf(source)[0].markdown, "| A | B |\n| --- | :---: |\n| **one** | two |");
  }
});

test("CSV quotes delimiters, quotes, Unicode, empty cells and line breaks", () => {
  const [data] = exportsOf('| A | B | C |\n| --- | --- | --- |\n| 你好, world | say "hi"<br>again | |');
  assert.equal(data.csv, '\uFEFF"A","B","C"\r\n"你好, world","say ""hi""\nagain",""\r\n');
});

test("pipe-less Markdown rows may start with inline HTML", () => {
  const [data] = exportsOf('<em>Name</em> | Value\n--- | ---\n<strong>Pi</strong> | `code`');
  assert.equal(data.markdown, '<em>Name</em> | Value\n| --- | --- |\n<strong>Pi</strong> | `code`');
});

test("spreadsheet formulas are text while ordinary signed numbers stay numeric", () => {
  const [data] = exportsOf('| A | B | C | D |\n| --- | --- | --- | --- |\n| =SUM(1,2) | +cmd | @name | -2.5 |');
  assert.equal(data.csv, '\uFEFF"A","B","C","D"\r\n"\'=SUM(1,2)","\'+cmd","\'@name","-2.5"\r\n');
});

test("math is exported once and images contribute their alternative text", () => {
  const [data] = exportsOf('| Formula | Image |\n| --- | --- |\n| $a+b$ | ![diagram](https://example.com/a.png) |');
  assert.equal(data.csv, '\uFEFF"Formula","Image"\r\n"a+b","diagram"\r\n');
});

test("raw HTML tables export sanitized visible text as a Markdown table", () => {
  const [data] = exportsOf('<table><tr><th>A</th><th>B</th></tr><tr><td>x|y</td><td>one<br>two<script>bad()</script></td></tr></table>');
  assert.equal(data.markdown, '| A | B |\n| --- | --- |\n| x\\|y | one<br>two |');
  assert.equal(data.csv, '\uFEFF"A","B"\r\n"x|y","one\ntwo"\r\n');
});

test("a streaming table exports the rows currently rendered", () => {
  const start = '| A |\n| --- |';
  assert.equal(exportsOf(start)[0].csv, '\uFEFF"A"\r\n');
  assert.equal(exportsOf(`${start}\n| next |`)[0].csv, '\uFEFF"A"\r\n"next"\r\n');
});
