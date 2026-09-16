import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * Issue #449: assistant replies that emit TeX `\[ … \]` display delimiters used
 * to reach the transcript as raw text. These cases render the real
 * `Markdown.tsx` through Vite SSR, so the whole production chain runs:
 * block splitting, `remark-math`, the TeX bracket normalizer, `rehype-raw`,
 * `rehype-sanitize` and `rehype-katex`.
 */
test("TeX bracket math renders through the production Markdown pipeline", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    // `useThemeMode` reads the theme off the document during render.
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule(
      "/src/components/Markdown.tsx",
    );
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en } },
    });
    const render = (source) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Markdown, { source }),
        ),
      );
    const display = (html) => html.includes("katex-display");
    const inline = (html) =>
      html.includes('class="katex"') && !html.includes("katex-display");

    // The issue's exact replies: a display formula on its own lines.
    const issueMultiline = render("\\[\nD \\leftrightarrow H\n\\]");
    assert.match(issueMultiline, /katex-display/);
    assert.doesNotMatch(issueMultiline, /\\\[/);
    const issueText = render(
      "\\[\n\\text{Data-RSI} \\leftrightarrow \\text{Harness-RSI}\n\\]",
    );
    assert.match(issueText, /katex-display/);
    // KaTeX keeps the TeX source in its MathML annotation, so only the bracket
    // delimiters (which used to leak as visible text) are checked here.
    assert.doesNotMatch(issueText, /\\\[|\\\]/);

    // TeX brackets are display math in every position, not only as a block:
    // `rehype-sanitize` has to keep `remark-math`'s math class for this to hold.
    for (const source of [
      "\\[a+b\\]",
      "Formally \\[ a+b \\] holds.",
      "Here is the mapping:\n\\[\nD \\leftrightarrow H\n\\]",
      "prose in between\n\n\\[\nX \\leftrightarrow Y\n\\]",
    ]) {
      assert.equal(display(render(source)), true, `expected display math: ${source}`);
    }

    // Inline code never turns into math. Fenced blocks and mermaid fences are
    // exercised at DOM level instead: `HighlightedCode` reads a browser-only
    // external store, so a fenced block cannot be server-rendered at all.
    const codeSpan = render("run `\\(inline\\)` now");
    assert.match(codeSpan, /<code[^>]*>\\\(inline\\\)<\/code>/);
    assert.doesNotMatch(codeSpan, /katex/);

    // Escaped and unmatched markers stay literal.
    assert.doesNotMatch(render("\\\\(escaped\\\\)"), /katex/);
    assert.doesNotMatch(render("text \\(unmatched"), /katex/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});
