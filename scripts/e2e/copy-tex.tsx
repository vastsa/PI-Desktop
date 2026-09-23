import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import baseCss from "../../apps/desktop/src/styles/base.css";
import katexCss from "katex/dist/katex.min.css";
import {
  ContextMenu,
  useContextMenu,
} from "../../apps/desktop/src/components/ContextMenu";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { useCopyTex } from "../../apps/desktop/src/hooks/use-copy-tex";
import {
  KATEX_DISPLAY_SELECTOR,
  KATEX_SELECTOR,
  KATEX_TEX_SELECTOR,
} from "../../apps/desktop/src/lib/selection-tex";

declare global {
  var copyTexProbe: () => Promise<unknown>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual(actual: string, expected: string, what: string): void {
  assert(
    actual === expected,
    `${what} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
}

/**
 * The real `Markdown` renderer under the real shell hook and the real
 * transcript menu: KaTeX paints both of its trees into a real document, a real
 * `Range` is dragged across them, and a real `copy` event carries whatever the
 * hook decided to write.
 */
function Fixture({
  cases,
  onMenuCopy,
}: {
  cases: Record<string, string>;
  onMenuCopy: (selection: string) => void;
}) {
  useCopyTex();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  return (
    <>
      {Object.entries(cases).map(([name, source]) => (
        <div
          className="prose-chat"
          data-case={name}
          key={name}
          onContextMenu={(event) =>
            openContextMenu(event, {
              label: "Message actions",
              items: [{ id: "copy", label: "Copy", onSelect: onMenuCopy }],
            })
          }
        >
          <Markdown source={source} />
        </div>
      ))}
      {/*
        A turn the way the transcript builds one: prose that opts into
        selection, with chrome between it that is inert only because it
        inherits the shell's `user-select: none`. `.tool-row-section-head` is
        one of the real ones; a `button` in its place would prove nothing,
        because `base.css` marks those inert by selector and they stay inert in
        any ancestor context.
      */}
      <div data-case="chrome">
        <div className="prose-chat">
          <Markdown source="Before $x^2$ here." />
        </div>
        <div className="tool-row-section-head">
          <span>Output</span>
        </div>
        <div className="prose-chat">
          <Markdown source="After the tool row." />
        </div>
      </div>
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
    </>
  );
}

type Copied = { prevented: boolean; text: string; html: string };

/**
 * A copy raised on `target`, which the listener must not read.
 *
 * Chromium picks the target itself, by walking the selection's canonicalized
 * start position up to its element — for every `selectContents` below that is
 * a descendant of the node the range was built on, never the node itself. The
 * cases pass both shapes in so a listener that started consulting the target
 * again would fail here rather than in the user's clipboard.
 */
function rawCopy(target: Element): Copied {
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", {
    bubbles: true,
    cancelable: true,
    clipboardData,
  });
  target.dispatchEvent(event);
  return {
    prevented: event.defaultPrevented,
    text: clipboardData.getData("text/plain"),
    html: clipboardData.getData("text/html"),
  };
}

const WRAPPED = [
  "A long sentence about $x$ that the model",
  "wrapped across two source lines and",
  "continues here.",
].join("\n");

const CASES = {
  displayBlank: "$$\n- x\n\n+ y\n$$",
  displayCrlf: "$$\r\n- x\r\n$$",
  displayMinus: "\\[ - x \\]",
  displayPlus: "\\[ + x \\]",
  displayStar: "\\[ * x \\]",
  displayQuote: "\\[ > x \\]",

  multilineDollar: "Value $$a +\n\\text{\\$5}$$ here.",
  multilineComment: "Value $$a % note\nb + \\text{\\$5}$$ here.",
  markerText: "\uE0000\uE000 $x$",
  multilineBoundary: "\\$**$$a +\n\\text{\\$5}$$**\\$",
  proseDollarAfter: "\\(x\\)\\$",
  proseDollarBefore: "\\$\\(x\\)",
  proseDollarsBoth: "\\$\\(x\\)\\$",
  proseDollarWrapped: "\\$**$x$**\\$",
  proseDollarBetween: "$x$\\$**$y$**",
  /*
    A prose dollar the escaping cannot see from a fence: one on each side of
    the formula and neither touching it. Left alone they pair across the
    formula's own fences — `Run $HOME then $x$ costs $5.` paints `HOME then `
    and ` costs ` and loses `x` entirely — so the round trip below, not the
    expected string, is what this case is here for.
  */
  proseDollarDistant: "Run \\$HOME then $x$ costs \\$5.",

  adjacent: "The identity $a$**$b$**$c$ closes the proof.",
  inertGap: "$a$**$b$**",
  separated: "$a$ **$b$**",
  lineBreak: "$a$  \n**$b$**",
  paragraphs: "$a$\n\n$b$",
  dollarAtEdge: "\\( 5\\$ \\)",
  padded: "$$  x  $$",
  trailingDollar: "\\(5\\$ \\)",
  inline: "The identity $a^2+b^2=c^2$ closes the proof.",
  display: "$$\n\\int_0^1 x^2\\,dx\n$$",
  mixed: "First paragraph.\n\n$$\nE = mc^2\n$$\n\nLast paragraph.",
  prose: "Nothing but prose here.",
  /*
    The shapes a model actually emits. `normalizeLatexMathDelimiters` rewrites
    `\[ … \]` in place — the rewrite is length-preserving — so the math node
    stays *inline* and `remarkLatexBracketDisplay` promotes it, which paints
    `.katex-display` inside the sentence's own paragraph. That is the only
    place the display slot lands in an inline context, and the only place the
    reduction nests a `p` in a `p`; both readings below pin what it produces.
  */
  bracketMid: "The result \\[E = mc^2\\] closes the proof.",
  bracketOwnLine: "\\[\nE = mc^2\n\\]",
  parenInline: "Inline \\(x^2\\) here.",
  /*
    The two shapes that decide the delimiter run in `texSource`, and the only
    cases here whose point is invisible in the clipboard string: a formula
    carrying a literal `$` needs a run that outgrows it, and a formula whose
    value carries a newline needs the run to stay narrow. The round trip below
    is what fails when either half of that rule is wrong.
  */
  dollar: "Cost \\(\\$5 + x\\) today.",
  multiline: "The value $a +\nb$ here.",
  /*
    The same narrow run, with the padding the grammar eats. The space on each
    side of the formula is load-bearing rather than stray: it is what leaves
    the annotation a line ending at either edge, which is the padding the copy
    then has to write back. Drop either space and this is `multiline` again.
  */
  paddedMultiline: "The value $ \na +\nb\n $ here.",
  // Everything below is prose the platform already serialized correctly: a
  // formula in the same selection must not rewrite any of it.
  wrapped: WRAPPED,
  list: "- first item with $x^2$\n- second item\n- third item",
  table: "| a | b |\n| --- | --- |\n| $x$ | 2 |\n| 3 | 4 |",
  /*
    A display slot inside a table cell — the one place a `$$` fence could be
    closed by a tab instead of a line ending. `remarkLatexBracketDisplay`
    promotes a `\[ … \]` node wherever it sits, cells included, so this is the
    shape that puts `.katex-display` inside a `<td>`. What the reading does
    there is measured below, not argued from the grammar.
  */
  tableDisplay: "| a | b |\n| --- | --- |\n| \\[E = mc^2\\] | 2 |",
  code: "Formula $x$ here.\n\n```js\nconst a = 1;\n\n\n\nconst b = 2;\n```",
};

/*
  The real stylesheets, not a restatement of them. The reduction reads its
  clone through the platform's text serializer, so the reading turns on
  `display`, `white-space`, `visibility` and `user-select` as the live cascade
  resolves them; a fixture that paraphrased those rules would drift from the
  app and could not tell the copy's own serializer apart from `innerText`,
  which ignores `user-select` and writes a code block's language rail into the
  clipboard.

  `base.css` carries the selection contract in its real shape — the shell is
  unselectable at `html, body, #root` and document-like surfaces opt back in,
  which is what the `chrome` case turns on: the default has to be *none* with
  surfaces opting in, not merely a few selectors saying `none`. KaTeX's own
  stylesheet is here because the wrapper is mounted inside the live formula
  whenever a selection never leaves one, so that cascade is the one the clone
  inherits (see `hostElementOf`).

  Two sheets, not the whole `styles/` directory, and the omission was checked
  rather than assumed: a sheet earns a place here only by deciding one of the
  four properties for content a formula can be selected with. `prose.css` does
  set `display`, `white-space` and `user-select` under `.prose-chat`, and every
  one of those either restates a UA default the fixture already gets
  (`.prose-chat .code-block pre code` re-declaring `pre`'s own
  `white-space: pre`) or sits inside an element `base.css` already marks inert
  (`.code-block-lang` under `.code-block-head`, which is what the `code` case's
  missing `js` rail proves). `messages.css` keeps its own `white-space` and
  `user-select` rules on surfaces that never render a formula — the user
  bubble, the edit textarea, tool-row gutters — so none of them moves a reading
  asserted below. The rest of what both sheets carry, `overflow` and
  `font-size` and spacing and colour, never reaches the text serializer. Add a
  sheet the moment that stops being true, not on principle: an unread rule here
  costs layout on every case and blurs which rule a reading rests on.

  Injected by hand rather than left to `Markdown`'s own
  `import "katex/dist/katex.min.css"`: that is a bare import of a file the
  package marks side-effect free, so the bundler drops it and nothing would
  reach the document. Keep both here even if the app's import starts surviving
  — the fixture has to name the cascade it tests.
*/
const STYLESHEETS = `${baseCss}\n${katexCss}`;

globalThis.copyTexProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const style = document.createElement("style");
  style.textContent = STYLESHEETS;
  document.head.append(style);
  const host = document.createElement("div");
  host.style.width = "700px";
  document.body.append(host);
  const root = createRoot(host);
  // Where a clipboard string is rendered back, to answer the only question the
  // strings below cannot: whether what the copy wrote still paints the formula
  // it came from. See `copy`.
  const echo = document.createElement("div");
  echo.className = "prose-chat";
  document.body.append(echo);
  const echoRoot = createRoot(echo);
  let menuCopy: string | null = null;
  try {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Fixture
            cases={CASES}
            onMenuCopy={(selection) => {
              menuCopy = selection;
            }}
          />
        </I18nextProvider>,
      ),
    );
    const selection = window.getSelection();
    assert(selection, "the document has no selection");
    const block = (name: string) => {
      const element = host.querySelector<HTMLElement>(`[data-case="${name}"]`);
      assert(element, `case ${name} did not render`);
      return element;
    };
    const select = (range: Range) => {
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const selectContents = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      select(range);
    };
    const rightClickCopy = async (row: Element): Promise<string> => {
      menuCopy = null;
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      const item = document.querySelector<HTMLElement>(
        '[data-context-menu-item="copy"]',
      );
      assert(item, "the context menu did not open");
      item.click();
      await Promise.resolve();
      return menuCopy ?? "";
    };

    /** Every formula in `element`, as the pair a round trip has to preserve. */
    const formulas = (element: Element) =>
      Array.from(element.querySelectorAll(KATEX_SELECTOR)).map((katex) => ({
        tex: katex.querySelector(KATEX_TEX_SELECTOR)?.textContent ?? "",
        display: Boolean(katex.closest(KATEX_DISPLAY_SELECTOR)),
      }));

    /*
      A copy, and the round trip that is the point of copying TeX at all.

      The strings the cases below assert say what reached the clipboard; they
      cannot say whether it still *means* the formula it came from. So every
      copy is rendered back through the same `Markdown` that painted the
      original — which is the paste path, `normalizeLatexMathDelimiters` and
      `remarkLatexBracketDisplay` included — and the formulas it paints are
      compared with the ones the selection covered, by TeX and by whether they
      are display math. That pins the delimiter choice (`$…$` inline so a
      pasted sentence cannot open a display block, `$$…$$` on their own lines
      so it does) and the one reading no expected string explains: a `\[ … \]`
      formula copies with a single newline above `$$`, which is enough for
      `remark-math` to open the display block it came from. Comparing against
      the live formulas rather than a literal keeps the expectation in one
      place — the fixture cannot pass by agreeing with itself.
    */
    const copy = (target: Element): Copied => {
      const copied = rawCopy(target);
      if (!copied.text) return copied;
      flushSync(() =>
        echoRoot.render(
          <I18nextProvider i18n={i18n}>
            <Markdown source={copied.text} />
          </I18nextProvider>,
        ),
      );
      assertEqual(
        JSON.stringify(formulas(echo)),
        JSON.stringify(formulas(target)),
        `formulas surviving ${JSON.stringify(copied.text)}`,
      );
      return copied;
    };

    // Exercise copy -> Markdown, including boundaries across formatting wrappers.
    for (const [name, expected] of [
      ["displayBlank", "$$\n- x\n\n+ y\n$$"],
      ["displayCrlf", "$$\n- x\n$$"],
      ["displayMinus", "$$\n- x\n$$"],
      ["displayPlus", "$$\n+ x\n$$"],
      ["displayStar", "$$\n* x\n$$"],
      ["displayQuote", "$$\n> x\n$$"],
      ["markerText", "\uE0000\uE000 $x$"],
      ["multilineBoundary", "\\$<span>$$a +\n\\text{\\$5}$$</span>\\$"],
      ["proseDollarAfter", "$x$\\$"],
      ["proseDollarBefore", "\\$$x$"],
      ["proseDollarsBoth", "\\$$x$\\$"],
      ["proseDollarWrapped", "\\$$x$\\$"],
      ["proseDollarBetween", "$x$\\$$y$"],
      ["proseDollarDistant", "Run \\$HOME then $x$ costs \\$5."],
      ["adjacent", "The identity $a$ $b$ $c$ closes the proof."],
      ["inertGap", "$a$ $b$"],
      ["separated", "$a$ $b$"],
      ["lineBreak", "$a$\n$b$"],
      ["paragraphs", "$a$\n\n$b$"],
      ["dollarAtEdge", "$$ 5\\$ $$"],
      ["padded", "$  x  $"],
      ["trailingDollar", "$$5\\$ $$"],
    ]) {
      const element = block(name);
      if (name === "inertGap") {
        const chrome = document.createElement("span");
        chrome.style.userSelect = "none";
        chrome.textContent = "Unselectable chrome";
        element.querySelector("strong")!.before(chrome);
      }
      selectContents(element);
      assertEqual(copy(element).text, expected, `${name} copy`);
      selectContents(element);
      assertEqual(await rightClickCopy(element), expected, `${name} menu copy`);
    }

    for (const name of ["multilineDollar", "multilineComment"]) {
      const element = block(name);
      const formula = element.querySelector(KATEX_SELECTOR)!;
      selectContents(element);
      copy(element);
      selectContents(formula);
      const copied = copy(element);
      selectContents(formula);
      assertEqual(await rightClickCopy(element), copied.text, `${name} menu copy`);
    }

    // Reuse the same mounted Markdown while a math fence streams across
    // blank lines. Its body must remain the tail until the fence closes.
    for (const suffix of ["", "\n\n+ y", "\n\n+ y\n$$", "\n\n+ y\n$$\n\nAfter."]) {
      const source = "Before.\n\n$$\n- x" + suffix;
      flushSync(() => echoRoot.render(
        <I18nextProvider i18n={i18n}><Markdown source={source} /></I18nextProvider>,
      ));
      assertEqual(JSON.stringify(formulas(echo)), JSON.stringify([
        { tex: suffix ? "- x\n\n+ y" : "- x", display: true },
      ]), "streaming display math");
      assert(!echo.querySelector("ul, ol, blockquote"), "math became a prose block");
      if (source.endsWith("After.")) {
        const after = Array.from(echo.querySelectorAll("p")).find(p => p.textContent === "After.");
        assert(after, "closed math swallowed the following paragraph");
        assertEqual(after.getAttribute("data-source-start") ?? "", String(source.indexOf("After.")), "following paragraph offset");
      }
    }

    /*
      Same mounted Markdown, streaming a footnote. The definition arrives after
      the paragraph that references it, so this is the one place the renderer
      has to give up block splitting: a reference resolved against its own
      slice alone survives as the literal `[^1]` and the note disappears.
    */
    for (const [source, resolved] of [
      ["Text[^1].\n", false],
      ["Text[^1].\n[^1]: adjacent note\n", true],
      ["Text[^1].\n[^1]: adjacent note\n\nAnd more[^2].\n\n[^2]: later note\n", true],
    ] as const) {
      flushSync(() => echoRoot.render(
        <I18nextProvider i18n={i18n}><Markdown source={source} /></I18nextProvider>,
      ));
      const notes = echo.querySelector("section[data-footnotes]");
      assert(resolved === Boolean(notes), `footnote section for ${JSON.stringify(source)}`);
      if (!notes) continue;
      assertEqual(
        echo.querySelectorAll("a[data-footnote-ref]").length.toString(),
        (source.match(/\[\^\d\]\./g) ?? []).length.toString(),
        "footnote references",
      );
      assert(!echo.textContent?.includes("[^"), "a footnote reference stayed literal");
      assert(notes.textContent?.includes("adjacent note"), "the note text is missing");
    }

    const inline = block("inline");
    assert(inline.querySelector(".katex"), "the inline formula did not render");
    assert(
      inline.querySelector('annotation[encoding="application/x-tex"]'),
      "KaTeX rendered no TeX annotation",
    );
    selectContents(inline);
    const rendered = selection.toString();
    const inlineCopy = copy(inline);
    assert(inlineCopy.prevented, "the inline copy was left to the platform");
    assertEqual(inlineCopy.text, CASES.inline, "inline copy");
    // The bug this fixes: the platform's own reading of the same selection.
    assert(
      rendered !== CASES.inline,
      "the rendering already reads as its source; this fixture proves nothing",
    );
    /*
      One flavour. Taking the copy over drops the platform's `text/html` too,
      and none is written back: the clone is the app's own markup, so it would
      carry the `user-select: none` chrome the text reading drops and paste the
      formula twice over, KaTeX's stylesheet being the only thing that hides
      the MathML tree. A rich paste target falls back to the plain text.
    */
    assertEqual(inlineCopy.html, "", "inline copy HTML flavour");

    const display = block("display");
    const wrapper = display.querySelector(".katex-display");
    assert(wrapper, "the display formula did not render in display layout");
    selectContents(display);
    assertEqual(copy(display).text, "$$\n\\int_0^1 x^2\\,dx\n$$", "display copy");
    // A range that stops at the display wrapper's own edges, rather than
    // inside the formula, still knows this is display math.
    selectContents(wrapper);
    assertEqual(
      copy(display).text,
      "$$\n\\int_0^1 x^2\\,dx\n$$",
      "display copy bounded by the wrapper",
    );

    const mixed = block("mixed");
    selectContents(mixed);
    assertEqual(copy(mixed).text, CASES.mixed, "mixed copy");

    /*
      `\[ … \]` display math sits inside the sentence's own paragraph, so the
      display slot lands in an inline context and the reduction nests a `p` in
      a `p`. The reading is still the one that matters: a single newline above
      `$$` is enough for `remark-math` to open the display block, so the
      formula pastes back as the display formula it came from. `\( … \)` is
      normalized to `$$ … $$` too but is never promoted, so it stays inline.
    */
    const bracketMid = block("bracketMid");
    assert(
      bracketMid.querySelector("p .katex-display"),
      "`\\[ … \\]` no longer renders as display math inside a paragraph",
    );
    selectContents(bracketMid);
    assertEqual(
      copy(bracketMid).text,
      "The result\n$$\nE = mc^2\n$$\n\ncloses the proof.",
      "bracket display copy",
    );

    const bracketOwnLine = block("bracketOwnLine");
    selectContents(bracketOwnLine);
    assertEqual(
      copy(bracketOwnLine).text,
      "$$\nE = mc^2\n$$",
      "bracket display copy on its own lines",
    );

    const parenInline = block("parenInline");
    assert(
      !parenInline.querySelector(".katex-display"),
      "`\\( … \\)` was promoted to display math",
    );
    selectContents(parenInline);
    assertEqual(copy(parenInline).text, "Inline $x^2$ here.", "paren inline copy");

    /*
      The delimiter run, in the two directions that pin it. A formula carrying
      a literal `$` needs a run wider than the one inside it — `$\$5 + x$`
      closes at the escaped dollar, and the round trip inside `copy` is what
      catches that, because the clipboard string looks right either way. A
      formula whose value carries a newline needs the run to stay narrow: `$$`
      would land at the start of a line with the rest of the formula behind it,
      which opens a flow block and swallows the paragraph. Only the `\( … \)`
      path has its newlines flattened by `normalizeLatexMathDelimiters`, so a
      `$ … $` formula really can reach the reduction with one in it.
    */
    const dollar = block("dollar");
    selectContents(dollar);
    assertEqual(copy(dollar).text, "Cost $$\\$5 + x$$ today.", "dollar copy");

    const multiline = block("multiline");
    assertEqual(
      multiline.querySelector(KATEX_TEX_SELECTOR)?.textContent ?? "",
      "a +\nb",
      "the inline formula lost the newline its source carried",
    );
    selectContents(multiline);
    assertEqual(
      copy(multiline).text,
      "The value $a +\nb$ here.",
      "multiline inline copy",
    );

    /*
      A line ending at either edge of the annotation is padding to the grammar,
      exactly as a space is, so the copy has to write padding of its own for
      the round trip inside `copy` to see the formula it started from.
    */
    const padded = block("paddedMultiline");
    assertEqual(
      padded.querySelector(KATEX_TEX_SELECTOR)?.textContent ?? "",
      "\na +\nb\n",
      "the inline formula lost the padding its source carried",
    );
    selectContents(padded);
    assertEqual(
      copy(padded).text,
      "The value $ \na +\nb\n $ here.",
      "padded multiline inline copy",
    );

    // A cut through the middle of a formula: half a TeX expression is not a
    // formula, so the range grows to the whole one before it is read.
    const glyphs = inline.querySelector(".katex-html");
    assert(glyphs, "KaTeX rendered no visual tree");
    const walker = document.createTreeWalker(glyphs, NodeFilter.SHOW_TEXT);
    const insideFormula = walker.nextNode();
    assert(insideFormula, "the visual tree carries no text");
    const paragraph = inline.querySelector("p");
    assert(paragraph, "the inline case rendered no paragraph");
    const partial = document.createRange();
    partial.setStart(insideFormula, 0);
    partial.setEnd(paragraph, paragraph.childNodes.length);
    select(partial);
    assertEqual(
      copy(inline).text,
      "$a^2+b^2=c^2$ closes the proof.",
      "partial copy",
    );

    /*
      A selection that never leaves the formula — a double-click on a glyph, a
      drag across half a rendering. Its common ancestor is inside the `.katex`
      the reduction replaces, so the clone is read mounted within the live
      formula; this is the case `hostElementOf` reasons about, and the reading
      it has to keep is one whole formula and nothing else.
    */
    const whole = document.createRange();
    whole.setStart(insideFormula, 0);
    whole.setEnd(insideFormula, (insideFormula as Text).length);
    select(whole);
    assertEqual(copy(inline).text, "$a^2+b^2=c^2$", "copy from inside one formula");

    /*
      Only the formulas are rewritten. The rest of the selection is the
      platform's own serialization, so a formula must not put the source's line
      wrapping back into a paragraph, and must not reflow a list, a table, or a
      code block that happens to share the selection with it.
    */
    const wrapped = block("wrapped");
    selectContents(wrapped);
    assertEqual(
      copy(wrapped).text,
      "A long sentence about $x$ that the model wrapped across two source" +
        " lines and continues here.",
      "wrapped-paragraph copy",
    );

    const list = block("list");
    selectContents(list);
    assertEqual(
      copy(list).text,
      "first item with $x^2$\nsecond item\nthird item",
      "list copy",
    );

    /*
      The trailing newline is the platform's: its own reading of this selection
      ends with one, formula or no formula, because that is how it closes a
      table's last row. It is asserted rather than trimmed for the same reason
      nothing else here is — the reduction answers for the formulas and for
      nothing around them. A clone read outside the context it came from loses
      it, which is how this line found the mount that keeps it.
    */
    const table = block("table");
    selectContents(table);
    assert(
      selection.toString().endsWith("\n"),
      "the platform stopped closing a table row with a newline",
    );
    assertEqual(copy(table).text, "a\tb\n$x$\t2\n3\t4\n", "table copy");

    /*
      Display math inside a table cell, which is the one shape whose reading
      cannot be predicted from the grammar and was measured instead.
      `remarkLatexBracketDisplay` promotes a `\[ … \]` node wherever it sits, so
      KaTeX paints `.katex-display` inside a `<td>` while the table serializer
      joins cells with tabs — which reads like a trap, since a `$$` fence
      closed by a tab would swallow the rest of the row into the formula
      (`a\tb\n$$\nE = mc^2\n$$\t2` is one math node whose value runs to the end
      of the line). It is not one: a block slot is a block boundary in a cell
      too, so the row breaks around it and the fence closes on its own line.
      The expected string below is what Chromium actually writes.

      The parity assertion is what makes that a guard rather than a snapshot.
      The platform's own reading of this row has no tab in it either — the
      `.katex-display` box breaks the row for the platform exactly as the slot
      does for the reduction — so the slot is not inventing a boundary, it is
      keeping the one that was already there. A reading that grew a tab would
      mean the block boundary had gone away, which is the case where the fence
      would have to narrow to the inline run; assert it here rather than
      narrowing pre-emptively and paying display math for a shape Chromium
      does not produce.
    */
    const tableDisplay = block("tableDisplay");
    assert(
      tableDisplay.querySelector(KATEX_DISPLAY_SELECTOR),
      "`\\[ … \\]` no longer renders as display math inside a table cell",
    );
    selectContents(tableDisplay);
    assert(
      !selection.toString().slice("a\tb".length).includes("\t"),
      `the platform started tab-joining a cell that holds a block: ${JSON.stringify(selection.toString())}`,
    );
    assertEqual(
      copy(tableDisplay).text,
      "a\tb\n$$\nE = mc^2\n$$\n\n2\n",
      "table display copy",
    );

    /*
      Asserted whole, not by fragments: the prose, the block's own bytes with
      its blank lines, and — the part fragments cannot see — the absence of the
      `js` language rail. `.code-block-head` is `user-select: none`, so the
      platform's copy leaves it behind and the reduction has to as well; a
      reading taken with `innerText` passes every `includes` here and still
      pastes a stray `js` line into the user's document.
    */
    const code = block("code");
    selectContents(code);
    const platformCode = selection.toString();
    assertEqual(
      copy(code).text,
      "Formula $x$ here.\n\nconst a = 1;\n\n\n\nconst b = 2;",
      "code copy",
    );
    assert(
      !platformCode.includes("js"),
      `the fixture lost its selection rules: ${JSON.stringify(platformCode)}`,
    );

    /*
      The clone is read in the ancestor context the selection came from, so
      the cascade that decides the reading is the live one — chrome that is
      inert only by inheriting the shell's `user-select: none` stays out of
      the clipboard, exactly as it does for the platform's own copy. A clone
      parked on `body` has to restate that contract to be readable at all, and
      restating it inverts it: the default turns selectable and this label
      arrives in the copy.
    */
    const chrome = block("chrome");
    selectContents(chrome);
    const platformChrome = selection.toString();
    assert(
      !platformChrome.includes("Output"),
      `the fixture lost its selection rules: ${JSON.stringify(platformChrome)}`,
    );
    assertEqual(
      copy(chrome).text,
      "Before $x^2$ here.\n\nAfter the tool row.",
      "copy across inert chrome",
    );

    // Prose without a formula stays the platform's business.
    const prose = block("prose");
    selectContents(prose);
    const proseCopy = copy(prose);
    assert(!proseCopy.prevented, "a formula-free copy was taken over");
    assert(proseCopy.text === "", "a formula-free copy wrote to the clipboard");

    /*
      The target Chromium really raises a copy on, which is not the node the
      range was built from. `selectNodeContents` — the shape the transcript's
      own "Select text" item produces — leaves anchor and focus on that node,
      while the event lands on the paragraph inside it. A listener that gated
      on `target.contains(anchorNode)` read this as a copy belonging to some
      other selection and handed the glyphs back; the whole selection has to
      reach the clipboard as its source however deep the event was raised.
    */
    selectContents(inline);
    assert(
      selection.anchorNode === inline && selection.focusNode === inline,
      "selectNodeContents stopped anchoring on the node it was given",
    );
    const raisedDeep = copy(inline.querySelector("p")!);
    assert(raisedDeep.prevented, "a copy raised inside the selection was declined");
    assertEqual(raisedDeep.text, CASES.inline, "copy raised on a descendant");

    /*
      The reduction borrows the live selection to read the clone back, so it
      has to hand it over unchanged — including which end the user is holding.
      A range does not carry that, which is why anchor and focus are restored
      rather than a cloned range: otherwise a backward selection comes back
      forward and the next Shift+Arrow grows it off the opposite edge.
    */
    const backwards = inline.querySelector("p");
    assert(backwards?.firstChild && backwards.lastChild, "the sentence is empty");
    const tail = backwards.lastChild as Text;
    selection.setBaseAndExtent(tail, tail.length, backwards.firstChild, 0);
    assert(selection.anchorNode === tail, "the fixture built a forward selection");
    const backwardCopy = copy(inline);
    assertEqual(backwardCopy.text, CASES.inline, "backward selection copy");
    assert(
      selection.anchorNode === tail && selection.focusNode === backwards.firstChild,
      "the copy turned a backward selection forward",
    );

    /*
      The transcript's right-click Copy reads the same selection through the
      same module, so the two entry points cannot put two readings of one
      selection on the clipboard — and a selection another row owns is still
      not this row's excerpt.
    */
    selectContents(inline);
    assertEqual(await rightClickCopy(inline), CASES.inline, "right-click Copy");
    selectContents(inline);
    assertEqual(
      await rightClickCopy(prose),
      "",
      "right-click Copy in another row",
    );

    return { ok: true, rendered, inline: inlineCopy.text };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    flushSync(() => echoRoot.unmount());
    echo.remove();
  }
};
