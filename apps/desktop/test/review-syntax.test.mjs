import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

function message(path, lines, extra = {}) {
  return {
    id: "syntax-message", role: "tool", content: "", createdAt: "2026-11-07",
    toolName: "Edit", toolStatus: "success",
    toolResult: { details: { root: "workspace", review: {
      version: 1, snapshotId: "syntax-snapshot", messageId: "syntax-message", path,
      operation: "edit", status: "modified", state: "active", additions: 1, deletions: 1,
      reversible: true, hunks: [{ header: "@@ -1,4 +1,4 @@", lines }], ...extra,
    } } },
  };
}
const styledTokens = html => [...html.matchAll(/<span style="([^"]+)">([^<]*)<\/span>/g)]
  .map(([, style, content]) => ({ style, content }));

async function setup(t, language) {
  const ssr = await slotSsr(t);
  const highlighter = await ssr.load("/src/lib/shiki.ts");
  if (!highlighter.tokenizeIncremental(null, "", language, "one-light")) {
    await new Promise(resolve => {
      const unsubscribe = highlighter.subscribeHighlighter(() => { unsubscribe(); resolve(); });
      highlighter.ensureLang(language);
    });
  }
  assert.ok(highlighter.tokenizeIncremental(null, "", language, "one-light"), "The real grammar must load before color assertions");
  const { ReviewChangeDetails, reviewDiffText } = await ssr.load("/src/components/ReviewChangeCard.tsx");
  const { HighlightedCode } = await ssr.load("/src/components/Markdown.tsx");
  return { ...ssr, highlighter, ReviewChangeDetails, reviewDiffText, HighlightedCode };
}

test("Review Python syntax uses exactly the regular code block's light/dark token styles", { timeout: 30000 }, async t => {
  const ssr = await setup(t, "python");
  const code = 'import json\ndef verify_case(root):\n    # Keep strings separate from keywords\n    return {"ok": True, "root": str(root)}';
  const row = message("src/verify_case.py", code.split("\n").map(text => ({ type: "add", text })));
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    const reference = styledTokens(ssr.render(createElement(ssr.HighlightedCode, { code, lang: "py" })));
    assert.ok(reference.length > 6, "The regular block must have real syntax tokens");
    assert.ok(new Set(reference.map(token => token.style)).size > 2, "Keywords, comments and strings are not one uniform color");
    const html = ssr.render(createElement(ssr.ReviewChangeDetails, { message: row, numbered: true, highlightCode: true }));
    assert.deepEqual(styledTokens(html), reference, `Review and regular code must agree in ${theme} mode`);
    assert.doesNotMatch(html, /diff-line-sign/, "Review retains the single-number gutter");
    assert.match(html, /diff-line add/, "Syntax coloring does not replace the addition row");
  }
});

test("Review tokenizes before and after snippets independently, preserving multiline grammar state", { timeout: 30000 }, async t => {
  const ssr = await setup(t, "javascript");
  document.documentElement.dataset.theme = "light";
  const lines = [
    { type: "del", text: "/* old comment" },
    { type: "add", text: 'const added = "new";' },
    { type: "context", text: "still a comment" },
    { type: "del", text: "*/" },
    { type: "add", text: "const done = true;" },
    { type: "context", text: "return done;" },
    { type: "context", text: "\\ No newline at end of file" },
  ];
  const before = ssr.highlighter.tokenizeIncremental(null, '/* old comment\nstill a comment\n*/\nreturn done;', "javascript", "one-light");
  const after = ssr.highlighter.tokenizeIncremental(null, 'const added = "new";\nstill a comment\nconst done = true;\nreturn done;', "javascript", "one-light");
  const { TokenLine } = await ssr.load("/src/components/Markdown.tsx");
  const expected = [before.tokens[0], after.tokens[0], after.tokens[1], before.tokens[2], after.tokens[2], after.tokens[3]]
    .flatMap(line => styledTokens(ssr.render(createElement(TokenLine, { line }))));
  const row = message("src/check.mjs", lines);
  const html = ssr.render(createElement(ssr.ReviewChangeDetails, { message: row, numbered: true, highlightCode: true }));
  assert.deepEqual(styledTokens(html), expected);
  assert.match(html, /\\ No newline at end of file/);
  assert.equal(ssr.reviewDiffText(row.toolResult.details.review), lines.reduce((out, line) => out + `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}\n`, "@@ -1,4 +1,4 @@\n").trimEnd());
});

test("Syntax coloring is opt-in; unknown languages and over-budget snippets remain escaped complete text", { timeout: 30000 }, async t => {
  const ssr = await setup(t, "javascript");
  const text = 'const value = "<script>unsafe</script>";';
  for (const props of [
    { message: message("file.js", [{ type: "add", text }]) },
    { message: message("file.unknown", [{ type: "add", text }]), highlightCode: true },
    { message: message("file.js", [{ type: "add", text: "x".repeat(2001) }]), highlightCode: true },
    { message: message("file.js", Array.from({ length: 801 }, () => ({ type: "add", text }))), highlightCode: true },
  ]) {
    const html = ssr.render(createElement(ssr.ReviewChangeDetails, props));
    assert.deepEqual(styledTokens(html), []);
    assert.doesNotMatch(html, /<script>/);
    if (props.message.toolResult.details.review.hunks[0].lines[0].text === text) assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    else assert.ok(html.includes("x".repeat(2001)), "Highlight budget never truncates the captured source");
  }
});
