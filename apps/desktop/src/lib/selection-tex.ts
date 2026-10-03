/**
 * The clipboard reading of a rendered selection that contains math.
 *
 * KaTeX paints one formula twice — a MathML tree for assistive technology and
 * a visual tree of positioned spans — and both are real text in the document.
 * The platform's own copy therefore writes a formula out as its glyphs, twice
 * over, and never as the source the answer was written in (issue #414). The
 * TeX the formula was built from is already in the document, in the MathML
 * `annotation`, so a selection that covers a formula is read from the
 * annotation instead of from the rendering.
 *
 * Only the formulas are rewritten. The prose, lists, tables and code blocks
 * around them are serialized by the platform itself — the reduced clone is
 * selected and read back through `Selection.toString()`, which is the
 * serializer a copy runs — so the rest of a selection that happens to contain
 * a formula keeps its browser reading except for the one syntax this module
 * makes load-bearing: touching fences are separated, and every dollar outside
 * a formula is escaped so it cannot pair with a fence written here — code
 * blocks included, because the serializer has already dropped their fences
 * and what reaches the clipboard from one is prose (see `renderedText`).
 * A hand-written walk of the tree
 * could only approximate those rules, and everywhere it fell short it would
 * silently rewrite content the platform already got right.
 *
 * ADR 0268 removed the old multi-action selection overlay. ADR 0306 later
 * restored a single Add to Conversation action, which reuses this payload to
 * preserve the source of selected formulas. The copy the user already performs
 * writes different bytes when, and only when, the selection contains a formula.
 *
 * The delimiters are the renderer's own: `lib/latex-math.ts` normalizes
 * `\(…\)` and `\[…\]` to `$…$` / `$$…$$` before `remark-math` runs, so a
 * formula copied out of an answer renders as that same formula when it is
 * pasted back into the composer.
 */

/** KaTeX keeps the TeX it rendered in this MathML annotation. */
export const KATEX_TEX_SELECTOR = 'annotation[encoding="application/x-tex"]';
/** One rendered formula, whichever of its two trees a node sits in. */
export const KATEX_SELECTOR = ".katex";
/** The wrapper KaTeX puts around a display formula. */
export const KATEX_DISPLAY_SELECTOR = ".katex-display";
/** The MathML tree, hidden by KaTeX's own stylesheet and by nothing else. */
const KATEX_MATHML_SELECTOR = ".katex-mathml";
/** The outermost element of a formula a range boundary landed inside. */
const KATEX_BOUNDARY_SELECTOR = `${KATEX_DISPLAY_SELECTOR}, ${KATEX_SELECTOR}`;

/* ---------- pure helpers ---------- */

/**
 * Inline math stays inside its line; display math takes a line of its own,
 * because a `$$` line is what opens a flow math block.
 *
 * Inline is the *narrow* run, `$…$`, even though `normalizeLatexMathDelimiters`
 * rewrites `\(…\)` to `$$…$$` — that form is forced on it by being
 * length-preserving, not chosen. The reason is not that a pasted sentence might
 * start a line with the formula: a single-line `$$…$$` never opens a display
 * block, because math flow forbids `$` in the meta that follows its opening
 * fence, so `$$x^2$$ here.` and even a bare `$$x^2$$` line both parse as text
 * math. The reason is that an inline formula's TeX can carry a newline —
 * `$a +\nb$` parses, and only the `\(…\)` path has its newlines flattened by
 * the normalization — and a `$$` run then lands at the start of a line with the
 * rest of the formula behind it, which *is* a flow opening and swallows the
 * paragraph. `$…$` spans the line ending instead, which is also why `texSlot`
 * needs `white-space: pre` for inline math and not only for display.
 *
 * The run is widened past any run inside the formula, which is the escalation
 * rule markdown already uses for code spans: `$\$5 + x$` closes at the escaped
 * dollar and pastes back as prose, while `$$\$5 + x$$` reads whole. Display
 * keeps a floor of two. The measure is the longest run anywhere in the formula
 * rather than a line-initial one, which over-widens a display fence that could
 * not have been closed early — cheaper than restating where a flow fence may
 * appear, and invisible to every formula that carries no `$` at all, which is
 * written exactly as it was before this rule existed.
 */
export function texSource(tex: string, display: boolean): string {
  const inner = Math.max(
    0,
    ...Array.from(tex.matchAll(/\$+/g), (run) => run[0].length),
  );
  const fence = "$".repeat(Math.max(display ? 2 : 1, inner + 1));
  if (display) return `${fence}\n${tex}\n${fence}`;
  // remark-math drops one space *or line ending* from each end of a run that
  // has data between them. Pad wherever it would, so the drop lands on padding
  // written here instead of on the formula. A dollar at either edge takes the
  // same padding for a different reason: without it that dollar lengthens the
  // fence. "Data" is the grammar's own test — anything that is neither a space
  // nor a line ending — and not `trim()`, which reads a tab as whitespace
  // where the grammar reads it as data.
  const padded =
    /^[ \r\n]/.test(tex) && /[ \r\n]$/.test(tex) && /[^ \r\n]/.test(tex);
  const pad = padded || tex.startsWith("$") || tex.endsWith("$");
  const source = `${fence}${pad ? ` ${tex} ` : tex}${fence}`;
  // Copying just the formula can move a widened fence to column zero, where
  // a newline makes it a flow opener. Keep an explicit inline context rather
  // than flattening TeX: a newline can terminate a % comment. This is literal
  // Markdown source, not a rich-clipboard HTML flavour.
  //
  // The test is formula-local, so it also wraps a formula the payload puts
  // mid-sentence, where that fence never reaches column zero and the tag is
  // pure noise — in a non-Markdown paste target, and in this app's own
  // composer, where it survives the round trip into the message the model is
  // sent. Deliberate: only `renderedText`
  // knows where a slot lands once the parts are joined, and reaching back into
  // this decision from there would couple the two for a shape that has to be
  // authored to exist at all — inline math carrying *both* a literal `$` and a
  // newline, which means a hand-written `$$…$$` run, since a single-dollar run
  // closes at the first inner dollar and the `\(…\)` path has its newlines
  // flattened by the normalization.
  //
  // The closing run is left unguarded, and not because it cannot reach column
  // zero: it does, whenever that same TeX also *ends* with a newline. Such a
  // formula cannot be written down on its own. Its source closed the same way,
  // on a line opening with `$$`, and only stayed inline because a later dollar
  // on that line spoiled the flow fence's meta — copying the formula alone
  // takes that neighbour away, and no padding brings it back, since a fence
  // still opens under three spaces of indent and a fourth would fall inside
  // the math. A bound on the round trip, not a repair this module can make.
  return fence.length > 1 && /[\r\n]/.test(tex)
    ? `<span>${source}</span>`
    : source;
}

/* ---------- DOM reduction ---------- */

/**
 * What a formula becomes before the platform serializes the clone.
 *
 * `white-space: pre` because a bare text node would have the newlines inside
 * `$$ … $$` collapsed away like any other source whitespace, and a block slot
 * for display math because that is how it earns its own lines — both out of
 * the same rules that give the surrounding prose its breaks, rather than out
 * of newlines written into the text by hand.
 *
 * A paragraph, not a bare block: the serializer gives `p` a blank line on each
 * side and a `div` only a single break, so a `div` slot pastes back as
 * `$$ … $$\nLast paragraph.`, which reads as one run-on block.
 *
 * Display math is not always block-level here, and the slot is deliberately
 * left alone when it is not. `\[ … \]` is rewritten to `$$ … $$` in place —
 * the normalization is length-preserving — so `remarkLatexBracketDisplay`
 * promotes an *inline* math node and KaTeX paints `.katex-display` inside the
 * sentence's own `<p>`; the slot is then a `p` nested in a `p`, which is
 * invalid as markup and harmless here, because the clone is never serialized
 * as HTML (see `texClipboardPayload`) and only ever read through the text
 * serializer. That reading treats the nested block as one boundary and yields
 * `The result\n$$\nE = mc^2\n$$\n\ncloses the proof.` — a single newline above
 * `$$` is enough for `remark-math` to open the display block, so the formula
 * pastes back as the display formula it came from. Both `\[ … \]` shapes are
 * covered by E2E-CHAT-copy-formula-as-tex; do not "fix" the nesting without
 * re-running it.
 *
 * The block slot survives a table cell, which the grammar argues it should not
 * and which is therefore measured rather than reasoned about. The same
 * promotion puts `.katex-display` inside a `<td>`, and the table serializer
 * joins cells with tabs, so a `$$` fence there looks like it would be closed
 * by the tab after it and swallow the rest of the row —
 * `a\tb\n$$\nE = mc^2\n$$\t2` is one math node whose value runs to the end of
 * the line. Chromium writes no such string: a block box is a block boundary in
 * a cell too, the row breaks around it, and the fence closes on its own line.
 * Nor is the slot inventing that boundary, which is the half that decides it —
 * the platform's own reading of the same row carries no tab either, because
 * `.katex-display` breaks the row for it as well. Narrowing to the inline run
 * inside a cell would pay display math to repair a shape the serializer does
 * not produce, and would write a tab back that the platform does not. Both the
 * reading and the platform's parity are asserted by the `tableDisplay` case in
 * `scripts/e2e/copy-tex.tsx`, so a serializer that started tab-joining a cell
 * holding a block fails there rather than in a clipboard.
 */
function texSlot(tex: string, display: boolean, doc: Document): HTMLElement {
  const slot = doc.createElement(display ? "p" : "span");
  slot.style.whiteSpace = "pre";
  slot.textContent = texSource(tex, display);
  return slot;
}

/**
 * A formula is one unit: its MathML tree and its visual tree are two
 * renderings of the same source, and keeping both duplicates the expression.
 *
 * KaTeX paints one `.katex` per formula and never nests them, so the static
 * list this walks cannot hold an element an earlier replacement detached.
 */
function replaceKatex(wrapper: Element, doc: Document): HTMLElement[] {
  const slots: HTMLElement[] = [];
  for (const katex of Array.from(wrapper.querySelectorAll(KATEX_SELECTOR))) {
    const tex = katex.querySelector(KATEX_TEX_SELECTOR)?.textContent;
    if (!tex?.trim()) {
      // Valid KaTeX always carries the annotation. Without it the formula
      // degrades to its visual tree alone rather than to the same expression
      // twice over: the MathML tree is hidden by a stylesheet, and no
      // stylesheet travels on the clipboard.
      katex.querySelector(KATEX_MATHML_SELECTOR)?.remove();
      continue;
    }
    const display = katex.closest(KATEX_DISPLAY_SELECTOR);
    // Preserve annotation whitespace: it may separate a literal dollar from
    // the closing fence. The emptiness check above must not normalize it.
    const slot = texSlot(tex, Boolean(display), doc);
    (display ?? katex).replaceWith(slot);
    slots.push(slot);
  }
  return slots;
}

/**
 * Expand a range that starts or ends inside a formula to the whole formula:
 * half a TeX expression is not a formula, and a cut between KaTeX's two trees
 * would take the source from one and the glyphs from the other. A display
 * formula carries its wrapper out with it, because that wrapper is what tells
 * the reduction it is a display one. Both boundaries only ever move outwards,
 * never inwards, so the expansion cannot drop content the range covered.
 *
 * Only the boundary containers are consulted, not the offsets, and that is a
 * decision rather than an oversight. A boundary that names a node inside a
 * formula while pointing at its very edge — `(firstGlyphTextNode, 0)` for a
 * range that stopped just short of the formula — does grow over that formula,
 * so such a copy carries one formula the selection did not cover. It is left
 * that way because the result is still a whole formula, which is the unit this
 * function exists to keep intact, and because Chromium canonicalizes selection
 * boundaries into text positions: pointer drags, keyboard extension and
 * `selectNodeContents` on a row all land inside a text node or on the row
 * itself. Reading the offsets would add a branch only a hand-built `Range`
 * reaches, to trade an over-inclusive copy for a half-formula one.
 */
function expandRangeToWholeKatex(range: Range): Range {
  const expanded = range.cloneRange();
  const boundaryFor = (node: Node | null): Element | null => {
    const element =
      node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    const katex = element?.closest?.(KATEX_BOUNDARY_SELECTOR) ?? null;
    return katex?.closest?.(KATEX_DISPLAY_SELECTOR) ?? katex;
  };
  const start = boundaryFor(expanded.startContainer);
  const end = boundaryFor(expanded.endContainer);
  if (start) expanded.setStartBefore(start);
  if (end) expanded.setEndAfter(end);
  return expanded;
}

/**
 * The platform's own reading of the reduced clone.
 *
 * The clone is selected and read back through `Selection.toString()` because
 * that is the serializer a copy actually runs, so the reduced selection is
 * read by the same code that read the original one: source line breaks
 * collapsed to spaces, `pre` kept byte for byte, one line per list item, tabs
 * between cells — and chrome the app marked `user-select: none` dropped.
 * `innerText` looks like the same reading and is not: it has no notion of
 * `user-select`, so it writes out the code block's language rail and the
 * action rows that `base.css` marks inert precisely so a copy leaves them
 * behind. Restating that rule here instead would be the hand-written walk this
 * module exists to avoid; running the platform's own serializer costs one
 * range and makes the parity exact rather than approximate.
 *
 * The reading needs layout, so the clone is attached off screen rather than
 * hidden — and attached inside the element the selection already lived in,
 * because for this serializer the cascade *is* the reading. `cloneContents`
 * keeps every ancestor below the range's common ancestor; mounting there
 * supplies the rest, so each ancestor-scoped rule resolves exactly as it did
 * live. That matters most for the one rule this module leans on: `base.css`
 * makes `html, body, #root` unselectable and has document-like surfaces opt
 * back in, so a clone parked on `body` reads back as the code blocks alone,
 * with every paragraph dropped. Restating the opt-in on the clone instead —
 * an inline `user-select: text` — looks like the cure and inverts the
 * contract: the default flips to selectable, and chrome that is inert only by
 * inheritance (a tool row's section head, a compact thinking row) arrives in
 * the clipboard. Borrowing the real ancestors settles both directions at once,
 * and does it without a second, duplicate-`id` copy of the chain under `body`.
 *
 * The wrapper is one element level the live tree does not have, so a rule
 * reaching the clone's top level through `>` or `:nth-child` misses it. Left
 * alone rather than engineered around, and on a fact rather than a law: the
 * reading turns on `display`, `white-space`, `visibility` and `user-select`,
 * and no rule in the app selects a direct child of a selection's common
 * ancestor to set one of them — the app's child combinators sit on chrome,
 * menus, settings and the composer, none of which renders a formula or reaches
 * this path. A rule that changed that would move one of the paragraph, list,
 * table or code readings in E2E-CHAT-copy-formula-as-tex, which is the guard;
 * rebuilding the ancestor chain to close the gap would trade it for a
 * duplicate-`id` clone and is not worth it. Mounting inside a React-rendered
 * parent is safe for the
 * same reason the swap below is: the node is added and removed inside one
 * synchronous task, so no render and no frame observes it, React does not
 * watch the DOM, and a `MutationObserver` sees the addition and the removal
 * together. `position: fixed` under a `transform`/`filter` ancestor only
 * changes which box it is fixed to, and an `overflow` ancestor only clips;
 * neither reaches the text serializer.
 *
 * The live selection is restored before returning, anchor and focus each to
 * the end it came from; the one `selectionchange` listener in the app
 * (`useComposerDraft`) ignores anchors outside the composer, and the event is
 * queued rather than dispatched mid-swap, so nothing observes the intermediate
 * state.
 */
function renderedText(
  wrapper: HTMLElement,
  host: Element,
  slots: HTMLElement[],
): string {
  const doc = host.ownerDocument;
  wrapper.style.cssText = "position:fixed;left:-99999px;top:0";
  host.append(wrapper);
  const selection = doc.defaultView?.getSelection() ?? null;
  /*
    Anchor and focus, not `getRangeAt(0)`: a range remembers where a selection
    starts and ends but not which end the user is holding, so restoring one
    through `addRange` turns every backward selection forward and sends the
    next Shift+Arrow off the opposite edge.
  */
  const restore =
    selection?.anchorNode && selection.focusNode
      ? ([
          selection.anchorNode,
          selection.anchorOffset,
          selection.focusNode,
          selection.focusOffset,
        ] as const)
      : null;
  try {
    // No view means no layout, and a reading taken without layout is the
    // whitespace-collapsing one this module must not produce. Returning ""
    // leaves the copy to the platform instead of writing a worse one.
    if (!selection) return "";
    // Preserve formula identity until after the browser has serialized the
    // selection. DOM siblings are not text neighbours: formatting vanishes,
    // inert chrome is omitted, and block boundaries contribute whitespace.
    // A fresh opaque marker avoids confusing formula slots with user text,
    // even when hidden nodes disappear between pieces of that text.
    const marker = `copy-tex:${crypto.randomUUID()}:`;
    const sources = slots.map((slot, index) => {
      const source = slot.textContent ?? "";
      slot.textContent = `${marker}${index}${marker}`;
      return source;
    });
    const range = doc.createRange();
    range.selectNodeContents(wrapper);
    selection.removeAllRanges();
    selection.addRange(range);
    const escape = (run: string) => run.replace(/[\\$]/g, "\\$&");
    const parts = selection.toString().split(new RegExp(`${marker}(\\d+)${marker}`));
    if (parts.length === 1) return parts[0];
    return parts.map((part, index) => {
      if (index % 2) {
        const source = sources[Number(part)];
        // Two inline fences need one separator after formatting is removed.
        const touchesFence =
          index > 1 && !parts[index - 1] &&
          sources[Number(parts[index - 2])].endsWith("$") &&
          source.startsWith("$");
        return (touchesFence ? " " : "") + source;
      }
      // A prose dollar must stay prose, wherever in the part it sits, and not
      // only where it touches a fence. This module is what makes `$`
      // load-bearing in the payload, so a lone prose dollar now has something
      // to pair with: `Use $HOME then $x$ here.` reads `HOME then ` as the
      // formula and drops `x`, and a second prose dollar pairs with the first
      // to make a formula out of the sentence between them. Escaping is
      // lossless because the math here is Markdown source already and `\$`
      // renders as a dollar — a positional rule would only be narrower, not
      // cheaper. Adding a space instead is not enough ("$ $x$" parses an empty
      // formula).
      //
      // A code block's text is not exempt, and exempting it would be a
      // regression rather than a repair. The serializer above writes a code
      // block out without its fences, so what lands in the payload is prose
      // and reads as prose: `echo $HOME and $PATH` on its own pairs its two
      // dollars and turns `HOME and ` into a formula. That corruption
      // predates this module — the platform's own copy produced it — and the
      // escape is what removes it. Exempting code would hand it back.
      //
      // Nor is a working paste being traded away, which is the part that does
      // not read off the code. Only a selection that holds a rendered formula
      // reaches this function at all (`texClipboardPayload` re-checks the
      // clone, not just the host), and that is exactly the selection whose
      // clipboard text was already unusable: every formula in it arrived
      // twice, as glyphs — issue #414. The cost is narrower than nothing at
      // all, and saying so is the honest version: a code block's own lines did
      // paste cleanly out of that ruined selection and now carry `\$`. It
      // stays the right trade, because the payload is one Markdown document
      // and because the selection copied for the sake of its code alone holds
      // no formula and never arrives here.
      //
      // Exempting code would also have to write its fences back to be sound,
      // since unfenced code is what lets its dollars pair in the first place.
      // That turns this module into one that reconstructs code blocks as well
      // as formulas — the structural walk the file header declines — and
      // moves the `code copy` reading E2E pins in scripts/e2e/copy-tex.tsx.
      //
      // The cost is the visible one and it is accepted: a payload pasted into
      // a terminal or another non-Markdown target shows `\$`. This flavour is
      // Markdown source, on the same ground D619 drops `text/html` on, and a
      // code block still carries its own copy button, which never reaches this
      // path and writes the literal text.
      const escaped = part.replace(/\\*\$/g, escape);
      // A trailing backslash run needs the same treatment with no dollar of
      // its own: what follows it in the text is a fence for it to escape.
      return index === parts.length - 1 ? escaped : escaped.replace(/\\+$/, escape);
    }).join("");
  } finally {
    // Unmount before restoring, so the clone cannot outlive the call through a
    // throwing restore. No such throw is reachable today — `setBaseAndExtent`
    // raises only `IndexSizeError`, nothing shrinks a boundary node between
    // the capture above and this line, and `expandRangeToWholeKatex` clones
    // the range rather than moving the live one — but the invariant the header
    // rests on is that no frame observes the clone, and the order is what
    // makes that structural instead of conditional on the restore.
    //
    // Free to take in this order: removing the wrapper only collapses the
    // range this function put inside it, which the restore then overwrites,
    // and `selectionchange` is queued and coalesced within the task, so the
    // app's one listener (`useComposerDraft`) sees the same end state either
    // way.
    wrapper.remove();
    if (restore) selection?.setBaseAndExtent(...restore);
    else selection?.removeAllRanges();
  }
}

/* ---------- live selection ---------- */

/**
 * The element the range's content already sits in: the ancestor context the
 * clone is read in, and the cheapest place to look for a formula. Null only
 * for a range whose common ancestor is the document itself, which no selection
 * the user can make produces — and which has nothing to borrow a cascade from
 * anyway, so the copy stays the platform's.
 *
 * For a selection that lies wholly inside one formula — a double-click on a
 * glyph, a drag across half a rendering — this is an element *inside* the
 * `.katex` the reduction replaces, so the clone is mounted within the live
 * formula and KaTeX's own stylesheet is what the wrapper inherits from. That
 * is intended, and it holds structurally rather than on any fact about that
 * stylesheet, which does set two of the four properties the text serializer
 * turns on (`.katex .base` is `display: inline-block; white-space: nowrap`).
 * A common ancestor inside a `.katex` means both range boundaries are inside
 * it, so `expandRangeToWholeKatex` widens to exactly that one formula and
 * `replaceKatex` leaves the clone holding exactly one slot — and the slot sets
 * its own `white-space`, the only one of the four that could move its reading.
 * There is no prose under that cascade for an inherited property to reach, and
 * the live tree is only ever read. E2E-CHAT-copy-formula-as-tex drags this
 * selection under the real KaTeX stylesheet, so a future rule that did reach
 * the reading surfaces there rather than in the user's clipboard.
 */
function hostElementOf(range: Range): Element | null {
  const container = range.commonAncestorContainer;
  return container.nodeType === 1
    ? (container as Element)
    : (container.parentElement ?? null);
}

function selectionRange(selection: Selection | null): Range | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  return selection.getRangeAt(0);
}

/**
 * Whether a selection hosted by `host` is worth cloning at all. Cheap, and
 * allowed to say yes too often because the clone is checked for a formula
 * anyway — so that the common copy, the one with no math anywhere near it,
 * does not deep-clone a whole transcript inside the event before finding that
 * out.
 *
 * This is the only gate, on purpose. A selection that does hold math is cloned
 * and laid out whole, however large, inside the event — because the platform
 * serializing that same selection is the cost being matched, and because a
 * size threshold above which the copy silently reverted to glyphs would make
 * one gesture return two different things depending on how long the
 * conversation had grown. The synchronous layout is the accepted price of that
 * parity, not an oversight to be bounded later.
 */
function mayContainKatex(host: Element): boolean {
  return Boolean(
    host.closest(KATEX_SELECTOR) ?? host.querySelector(KATEX_SELECTOR),
  );
}

/**
 * The `text/plain` a copy should carry for `selection`, or null when this
 * module has nothing to add — no selection, or a selection with no rendered
 * formula in it. Returning null is how every caller keeps the platform's own
 * copy: rewriting a selection that holds no math could only make it worse.
 *
 * One flavour, and only one. Taking the copy over drops the platform's
 * `text/html` too, and none is written back. The clone is the app's own
 * markup, so serializing it would carry the chrome `base.css` marks
 * `user-select: none` — a code block's `js` rail and its copy button — which
 * the text reading drops, plus `data-source-*` bookkeeping and the nested
 * display slot `texSlot` describes: a second, worse reading of one selection.
 * Leaving it out is also what keeps a formula from pasting twice over, since
 * KaTeX's stylesheet is the only thing hiding the MathML tree and no
 * stylesheet travels on the clipboard. A rich paste target falls back to the
 * plain text, which is the source the user asked for.
 *
 * That fallback is the known cost, not an oversight: a selection holding a
 * formula now pastes into a rich target without the tag-level formatting the
 * platform's own `text/html` carried. Keeping the formatting would mean
 * reconstructing that flavour here — stripping the inert chrome, stripping the
 * bookkeeping, and splitting the paragraph the display slot nests in — which
 * is the hand-written structural walk this module exists to avoid. D619 weighs
 * the trade and takes the deletion; reopen it there, not here.
 */
export function texClipboardPayload(selection: Selection | null): string | null {
  const live = selectionRange(selection);
  const host = live ? hostElementOf(live) : null;
  if (!live || !host || !mayContainKatex(host)) return null;
  const doc = host.ownerDocument;

  const wrapper = doc.createElement("div");
  wrapper.append(expandRangeToWholeKatex(live).cloneContents());
  if (!wrapper.querySelector(KATEX_SELECTOR)) return null;

  const slots = replaceKatex(wrapper, doc);
  return renderedText(wrapper, host, slots) || null;
}
