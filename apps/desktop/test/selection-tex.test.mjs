import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  KATEX_DISPLAY_SELECTOR,
  KATEX_SELECTOR,
  KATEX_TEX_SELECTOR,
  texSource,
} from "../src/lib/selection-tex.ts";

/*
 * Issue #414: a formula copied out of an answer pasted as the glyphs KaTeX
 * painted, not as the TeX it was written in. What the reduction does to a real
 * selection is proven against a real Chromium in `pnpm test:e2e:copy-tex`,
 * which drags real `Range`s across real KaTeX output; the reading of ordinary
 * prose, lists, tables and code blocks around a formula is checked there too,
 * because that reading belongs to the platform and only a real one can answer
 * for it.
 *
 * What stays here answers questions that suite cannot: the pure delimiter
 * contract, the shape the markdown pipeline actually paints a formula in, and
 * the one wiring fact a fixture that mounts the hook itself would miss. It
 * asserts on behaviour, never on the text of the modules under test — a suite
 * that matches source against regexes fails on a rename and passes on an
 * inverted condition.
 */

const shell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);

test("inline math stays in its line and display math takes the lines around it", () => {
  assert.equal(texSource("a^2+b^2", false), "$a^2+b^2$");
  assert.equal(texSource("\\int_0^1 x^2\\,dx", true), "$$\n\\int_0^1 x^2\\,dx\n$$");
  /*
    A run that outgrows anything inside the formula, as a code span's does:
    `$\$5 + x$` would close at the escaped dollar and paste back as prose. The
    display fence already clears a single `$`, so it only widens past a run of
    two or more. What the widened form still *means* is answered by the round
    trip in `pnpm test:e2e:copy-tex`, not here.
  */
  assert.equal(texSource("\\$5 + x", false), "$$\\$5 + x$$");
  assert.equal(texSource("\\$5 + x", true), "$$\n\\$5 + x\n$$");
  assert.equal(texSource("a$$b", false), "$$$a$$b$$$");
  assert.equal(texSource("5\\$ ", false), "$$5\\$ $$");
  assert.equal(texSource("5\\$", false), "$$ 5\\$ $$");
  assert.equal(texSource(" x ", false), "$  x  $");
  /*
    Padding answers a line ending at the edges as it answers a space, because
    the grammar drops either one. `$\nx\n$` would read back as `x`.
  */
  assert.equal(texSource("\nx\n", false), "$ \nx\n $");
  assert.equal(texSource("\n\tx\t\n", false), "$ \n\tx\t\n $");
  assert.equal(texSource("\nx", false), "$\nx$");
  assert.equal(
    texSource("a % note\nb + \\text{\\$5}", false),
    "<span>$$a % note\nb + \\text{\\$5}$$</span>",
  );
});

test("a copied formula uses the delimiters the renderer itself accepts", async () => {
  // `normalizeLatexMathDelimiters` rewrites `\(…\)` / `\[…\]` to these before
  // `remark-math` runs, so a pasted formula renders as the one it came from.
  const { normalizeLatexMathDelimiters } = await import("../src/lib/latex-math.ts");
  assert.equal(normalizeLatexMathDelimiters(texSource("x^2", false)), "$x^2$");
  assert.equal(
    normalizeLatexMathDelimiters(texSource("x^2", true)),
    "$$\nx^2\n$$",
  );
  /*
    The rewrite is length-preserving, which is why a `\[ … \]` formula stays
    *inline* in its paragraph and why the display slot can land in an inline
    context at all. `texSlot` documents what the reduction makes of that, and
    `pnpm test:e2e:copy-tex` pins the reading; this is the premise both rest on.
  */
  assert.equal(
    normalizeLatexMathDelimiters("The result \\[E = mc^2\\] closes the proof."),
    "The result $$E = mc^2$$ closes the proof.",
  );
  assert.equal(normalizeLatexMathDelimiters("Inline \\(x^2\\) here."), "Inline $$x^2$$ here.");
  // A widened run is already dollar syntax; the normalization leaves it alone.
  assert.equal(
    normalizeLatexMathDelimiters(texSource("\\$5 + x", false)),
    "$$\\$5 + x$$",
  );
});

test("the shell mounts the one document copy listener", () => {
  /*
    The only fact the Chromium suite cannot see: it mounts `useCopyTex` itself,
    so a hook nobody installs would still pass there. Everything else about the
    listener — which copies it claims, which it declines, and what it writes —
    is behaviour, and behaviour is asserted against a real selection in
    `pnpm test:e2e:copy-tex` rather than against the text of the module.
  */
  assert.match(shell, /import \{ useCopyTex \} from "\.\.\/\.\.\/hooks\/use-copy-tex";/);
  assert.match(shell, /^ {2}useCopyTex\(\);$/m);
});

test("KaTeX still emits the trees and the annotation the reduction reads", async () => {
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
    const { Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (text) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(Markdown, { source: text })),
      );

    // The selectors are read straight off the module, so a rename here has to
    // agree with what the pipeline actually paints.
    const className = (selector) => selector.replace(/^\./, "");
    const inline = render("The identity $a^2+b^2=c^2$ closes the proof.");
    assert.match(inline, new RegExp(`class="${className(KATEX_SELECTOR)}"`));
    assert.doesNotMatch(inline, new RegExp(className(KATEX_DISPLAY_SELECTOR)));
    // Both trees are painted, which is why copying the rendering duplicates it.
    assert.match(inline, /class="katex-mathml"/);
    assert.match(inline, /class="katex-html"/);
    assert.match(inline, /<annotation encoding="application\/x-tex">a\^2\+b\^2=c\^2<\/annotation>/);
    assert.equal(KATEX_TEX_SELECTOR, 'annotation[encoding="application/x-tex"]');

    const display = render("$$\n\\int_0^1 x^2\\,dx\n$$");
    assert.match(display, new RegExp(className(KATEX_DISPLAY_SELECTOR)));
    assert.match(display, /<annotation encoding="application\/x-tex">/);
    // The annotation carries the source, not the glyphs: this is the string the
    // clipboard gets back.
    assert.match(display, /\\int_0\^1 x\^2\\,dx/);

    /*
      `\[ … \]` is display math painted *inside* a paragraph, because the
      normalization is length-preserving and `remarkLatexBracketDisplay`
      promotes an inline node. This is the only shape in which the reduction
      nests its display slot in a paragraph, so `texSlot` reasons about it
      explicitly; pin it here so a pipeline change surfaces as this assertion
      rather than as a wrong clipboard string.
    */
    const bracket = render("The result \\[E = mc^2\\] closes the proof.");
    assert.match(bracket, /<p[^>]*>(?:(?!<\/p>).)*katex-display/s);
    // `\( … \)` normalizes to `$$ … $$` as well but is never promoted.
    assert.doesNotMatch(
      render("Inline \\(x^2\\) here."),
      new RegExp(className(KATEX_DISPLAY_SELECTOR)),
    );
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});
