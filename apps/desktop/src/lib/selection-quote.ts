/**
 * Selection overlay geometry and selection → Markdown recovery for message
 * quotes (ADR message-quotes-and-side-chats / D-LOCAL-selection-overlay).
 *
 * Mirrors the ChatGPT desktop app's selected-text overlay: one pill floats
 * *above* the selection, horizontally centered on it, inside the bounds of the
 * scroll container it lives in (and above the docked composer), and it follows
 * the selection while the thread scrolls instead of disappearing.
 *
 * A selection inside a rendered answer is DOM, not source text: KaTeX paints
 * two parallel trees per formula, the highlighter splits one fence into a span
 * per token, and a table renders as cells. Handing that DOM to the composer
 * duplicates every formula, flattens every table, and turns code into
 * decorations, so a clone of the range is reduced back to Markdown — `$…$` TeX,
 * fenced code, one line per table row — before it becomes draft text.
 *
 * The overlay and the per-message action row both quote through
 * {@link serializeSelectionMarkdown}: one recovery path, not two spellings of
 * the same mistake.
 */

/** Gap between the selection and the floating pill. */
export const SELECTION_QUOTE_GAP = 8;
/** Smallest distance the pill keeps from the bounds it is clamped into. */
export const SELECTION_QUOTE_MARGIN = 8;
/** Markdown fences start at three backticks and grow past the longest run. */
export const SELECTION_QUOTE_MIN_FENCE = 3;

/** The transcript row attribute a quotable selection anchors to (D-LOCAL-message-quotes). */
export const QUOTABLE_ROW_ATTRIBUTE = "data-minimap-id";
/** Row role attribute: annotations belong to assistant turns (D-LOCAL-response-annotations). */
export const ROW_ROLE_ATTRIBUTE = "data-row-role";
/** The role value that takes response annotations instead of a draft quote. */
export const ANNOTATABLE_ROW_ROLE = "assistant";
/** The docked composer's own element, which the pill must stay above. */
export const COMPOSER_DOCK_SELECTOR = '[data-composer-dock="docked"]';

const KATEX_TEX_SELECTOR = 'annotation[encoding="application/x-tex"]';
const OVERFLOW_VALUES = new Set(["auto", "clip", "hidden", "overlay", "scroll"]);

/** Viewport rectangle, structurally typed so geometry stays testable. */
export type SelectionQuoteRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** The box the pill has to stay inside. */
export type SelectionQuoteBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Everything the pill needs to render and act on one selection. */
export type SelectionQuoteTarget = {
  /** Transcript row the selection belongs to; the quote and fork anchor. */
  rowAnchorId: string;
  /** The selection, already reduced to the Markdown the composer receives. */
  markdown: string;
  /** Visible part of the selection, in viewport coordinates. */
  anchor: SelectionQuoteRect;
  /** Bounds the pill is clamped into. */
  bounds: SelectionQuoteBounds;
  /**
   * Whether the row is an assistant turn. Annotations are a response concept
   * (D-LOCAL-response-annotations): a selection in the user's own message still quotes into the draft.
   */
  annotatable: boolean;
};

/* ---------- pure helpers ---------- */

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    if (value === character) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * A fence long enough to contain `text`, so quoting a snippet that itself
 * contains backticks cannot break out of the block.
 */
export function codeFenceFor(
  text: string,
  minimum = SELECTION_QUOTE_MIN_FENCE,
): string {
  return "`".repeat(Math.max(minimum, longestRun(text, "`") + 1));
}

/**
 * Collapse the whitespace the rendered DOM adds back to source-like text:
 * markup indentation, non-breaking spaces, soft hyphens, and the blank lines
 * that separating blocks introduce.
 */
export function normalizeSelectionMarkdown(value: string): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The part of `rect` that is inside `bounds`, or null when they do not overlap.
 * A selection scrolled half out of its container is anchored to the half that
 * is still on screen.
 */
export function intersectSelectionQuoteRect(
  rect: SelectionQuoteRect,
  bounds: SelectionQuoteBounds,
): SelectionQuoteRect | null {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  if (left >= right || top >= bottom) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Place the pill above the selection, centered on it, then clamp it into the
 * bounds. Only the horizontal axis can collide (the pill is narrow and near the
 * top of the selection), so a selection against the right edge slides left
 * instead of leaving the container. Returns the measured width cap too, so a
 * narrow panel cannot push the pill out of its own bounds.
 */
export function placeSelectionQuote({
  anchor,
  size,
  bounds,
  margin = SELECTION_QUOTE_MARGIN,
  gap = SELECTION_QUOTE_GAP,
}: {
  anchor: SelectionQuoteRect;
  size: { width: number; height: number };
  bounds: SelectionQuoteBounds;
  margin?: number;
  gap?: number;
}): { top: number; left: number; maxWidth: number } {
  const maxWidth = Math.max(0, bounds.right - bounds.left - margin * 2);
  const width = Math.min(size.width, maxWidth);
  const maximumLeft = Math.max(bounds.left + margin, bounds.right - margin - width);
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - width / 2, bounds.left + margin),
    maximumLeft,
  );
  const maximumTop = Math.max(bounds.top + margin, bounds.bottom - size.height);
  const top = Math.min(
    Math.max(anchor.top - gap - size.height, bounds.top + margin),
    maximumTop,
  );
  return { top, left, maxWidth };
}

/* ---------- DOM reduction ---------- */

function replaceWithText(node: Element, text: string, doc: Document): void {
  node.replaceWith(doc.createTextNode(text));
}

/**
 * A formula is one unit: KaTeX's MathML tree and its visual tree are two
 * renderings of the same source, and copying both duplicates the expression.
 * The TeX annotation is the source, so the whole formula is replaced by it —
 * `$…$` inline, `$$…$$` for a display block.
 */
function replaceKatex(wrapper: Element, doc: Document): void {
  for (const katex of Array.from(wrapper.querySelectorAll(".katex"))) {
    const tex = katex.querySelector(KATEX_TEX_SELECTOR)?.textContent?.trim();
    const isDisplay = Boolean(katex.closest(".katex-display"));
    if (tex) {
      replaceWithText(katex, isDisplay ? `\n$$\n${tex}\n$$\n` : `$${tex}$`, doc);
      continue;
    }
    // Valid KaTeX always carries the annotation; keep one rendering if not.
    const fallback =
      katex.querySelector(".katex-html")?.textContent ?? katex.textContent ?? "";
    replaceWithText(katex, fallback, doc);
  }
}

function fencedBlock(code: string, language: string): string {
  const fence = codeFenceFor(code);
  return `\n${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}\n`;
}

function replaceCodeBlocks(wrapper: Element, doc: Document): void {
  for (const block of Array.from(wrapper.querySelectorAll(".code-block"))) {
    const language = (block.querySelector(".code-block-lang")?.textContent ?? "")
      .trim()
      .replace(/[^A-Za-z0-9_+.-]/g, "");
    const code = block.querySelector("pre code")?.textContent ?? "";
    replaceWithText(block, fencedBlock(code, language), doc);
  }
  // A `pre` outside the app's code-block wrapper (or one reached on its own) is
  // still code, and quoting it line by line would read as prose.
  for (const pre of Array.from(wrapper.querySelectorAll("pre"))) {
    const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    replaceWithText(pre, fencedBlock(code, ""), doc);
  }
}

function replaceInlineCode(wrapper: Element, doc: Document): void {
  for (const code of Array.from(wrapper.querySelectorAll("code"))) {
    if (code.closest("pre")) continue;
    const value = code.textContent ?? "";
    const fence = codeFenceFor(value, 1);
    replaceWithText(code, `${fence}${value}${fence}`, doc);
  }
}

function replaceTaskCheckboxes(wrapper: Element, doc: Document): void {
  for (const input of Array.from(
    wrapper.querySelectorAll('input[type="checkbox"]'),
  )) {
    replaceWithText(input, (input as HTMLInputElement).checked ? "[x] " : "[ ] ", doc);
  }
}

/**
 * Drop transcript chrome, and unwrap the rest of the controls: a file-reference
 * chip renders its code inside a button, so removing buttons outright would
 * delete the text the user selected.
 */
function removeChrome(wrapper: Element): void {
  for (const node of Array.from(
    wrapper.querySelectorAll(
      [
        ".message-actions",
        ".code-block-head",
        // Annotation markers are references, not text the user picked (D-LOCAL-response-annotations).
        ".response-annotation-marker",
        "script",
        "style",
        "noscript",
        "template",
        "[hidden]",
        '[aria-hidden="true"]',
        ".sr-only",
      ].join(","),
    ),
  )) {
    node.remove();
  }
  for (const button of Array.from(wrapper.querySelectorAll("button"))) {
    button.replaceWith(...Array.from(button.childNodes));
  }
}

/**
 * A row is the smallest unit that carries meaning across the visual column
 * split, so each row becomes one `a | b` line.
 */
function replaceTables(wrapper: Element, doc: Document): void {
  for (const row of Array.from(wrapper.querySelectorAll("tr"))) {
    const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"));
    if (cells.length === 0) continue;
    const value = cells
      .map((cell) => (cell.textContent ?? "").trim().replace(/\s*\n\s*/g, " "))
      .join(" | ");
    replaceWithText(row, `${value}\n`, doc);
  }
}

function replaceLists(wrapper: Element, doc: Document): void {
  // Innermost first: a nested item must become text before its parent reads it.
  for (const item of Array.from(wrapper.querySelectorAll("li")).reverse()) {
    const parent = item.parentElement;
    let prefix = "- ";
    if (parent?.tagName?.toLowerCase() === "ol") {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName?.toLowerCase() === "li",
      );
      const start = Number.parseInt(parent.getAttribute("start") ?? "1", 10) || 1;
      prefix = `${start + Math.max(0, siblings.indexOf(item))}. `;
    }
    replaceWithText(item, `${prefix}${(item.textContent ?? "").trim()}\n`, doc);
  }
}

function replaceHeadings(wrapper: Element, doc: Document): void {
  for (let level = 1; level <= 6; level += 1) {
    for (const heading of Array.from(wrapper.querySelectorAll(`h${level}`))) {
      replaceWithText(
        heading,
        `\n${"#".repeat(level)} ${(heading.textContent ?? "").trim()}\n`,
        doc,
      );
    }
  }
}

function addBlockBoundaries(wrapper: Element, doc: Document): void {
  for (const br of Array.from(wrapper.querySelectorAll("br"))) {
    replaceWithText(br, "\n", doc);
  }
  for (const rule of Array.from(wrapper.querySelectorAll("hr"))) {
    replaceWithText(rule, "\n---\n", doc);
  }
  for (const block of Array.from(
    wrapper.querySelectorAll("p, pre, blockquote, section, article, div"),
  )) {
    block.before(doc.createTextNode("\n"));
    block.after(doc.createTextNode("\n"));
  }
}

/**
 * Expand a range that starts or ends inside a formula to the whole formula:
 * half of a TeX expression is not a quote, and KaTeX's two trees make a partial
 * cut ambiguous anyway. Both boundaries only ever move within the row the
 * selection already covers, so no extra containment check is needed.
 */
export function expandRangeToWholeKatex(range: Range): Range {
  const expanded = range.cloneRange();
  const boundaryFor = (node: Node | null): Element | null => {
    const element =
      node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    const katex = element?.closest?.(".katex") ?? null;
    return katex?.closest?.(".katex-display") ?? katex;
  };
  const start = boundaryFor(expanded.startContainer);
  const end = boundaryFor(expanded.endContainer);
  if (start) expanded.setStartBefore(start);
  if (end) expanded.setEndAfter(end);
  return expanded;
}

/**
 * The Markdown a rendered selection stands for. Returns an empty string when
 * there is nothing quotable, which every caller treats as "keep the pill
 * hidden".
 */
export function serializeSelectionMarkdown(range: Range | null): string {
  if (!range) return "";
  const ownerDocument =
    range.commonAncestorContainer?.ownerDocument ??
    (range.commonAncestorContainer?.nodeType === 9
      ? (range.commonAncestorContainer as unknown as Document)
      : null) ??
    (typeof document === "undefined" ? null : document);
  if (!ownerDocument) return "";

  const wrapper = ownerDocument.createElement("div");
  wrapper.append(expandRangeToWholeKatex(range).cloneContents());

  // Order matters: formulas and code are reduced before chrome is dropped and
  // before generic block boundaries are inserted, or their own markup would be
  // flattened into the text the reduction is looking for.
  replaceKatex(wrapper, ownerDocument);
  replaceCodeBlocks(wrapper, ownerDocument);
  replaceInlineCode(wrapper, ownerDocument);
  replaceTaskCheckboxes(wrapper, ownerDocument);
  removeChrome(wrapper);
  replaceTables(wrapper, ownerDocument);
  replaceLists(wrapper, ownerDocument);
  replaceHeadings(wrapper, ownerDocument);
  addBlockBoundaries(wrapper, ownerDocument);

  return normalizeSelectionMarkdown(wrapper.textContent ?? "");
}

/* ---------- live selection ---------- */

/** The transcript row a node sits in, or null when the selection is elsewhere. */
export function quotableRowFor(node: Node | null | undefined): Element | null {
  const element =
    node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  return element?.closest?.(`[${QUOTABLE_ROW_ATTRIBUTE}]`) ?? null;
}

/** Whether a transcript row is an assistant turn (the annotatable kind). */
export function isAnnotatableRow(row: Element | null): boolean {
  return row?.getAttribute?.(ROW_ROLE_ATTRIBUTE) === ANNOTATABLE_ROW_ROLE;
}

/** The document selection, when it is a non-empty text range. */
export function activeSelectionRange(): Range | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return range.toString().trim() ? range : null;
}

/**
 * Keep a range inside one element: a drag that leaves the row must not pull the
 * next row's text into the quote.
 */
export function clampRangeToElement(range: Range, element: Element): Range {
  const clamped = range.cloneRange();
  const contents = range.startContainer.ownerDocument!.createRange();
  contents.selectNodeContents(element);
  if (
    !element.contains(clamped.startContainer) ||
    clamped.compareBoundaryPoints(Range.START_TO_START, contents) < 0
  ) {
    clamped.setStart(contents.startContainer, contents.startOffset);
  }
  if (
    !element.contains(clamped.endContainer) ||
    clamped.compareBoundaryPoints(Range.END_TO_END, contents) > 0
  ) {
    clamped.setEnd(contents.endContainer, contents.endOffset);
  }
  return clamped;
}

/**
 * The visible band the pill may use: every scrollable ancestor's rect (the
 * transcript scroller is one) intersected with the viewport, and capped by the
 * docked composer — which floats over the transcript, so the scroller's own
 * bottom edge is not the visible bottom.
 */
export function selectionQuoteBounds({
  element,
  viewport,
  bottomBoundaryTop,
}: {
  element: Element | null;
  viewport: { width: number; height: number };
  bottomBoundaryTop?: number | null;
}): SelectionQuoteBounds | null {
  const bounds: SelectionQuoteBounds = {
    left: 0,
    top: 0,
    right: viewport.width,
    bottom:
      typeof bottomBoundaryTop === "number"
        ? Math.min(viewport.height, bottomBoundaryTop)
        : viewport.height,
  };
  const ownerDocument = element?.ownerDocument;
  const view = ownerDocument?.defaultView;
  let node: Element | null = element;
  while (node && node !== ownerDocument?.body && node !== ownerDocument?.documentElement) {
    const style = view?.getComputedStyle?.(node);
    // `overflow: hidden` on a decorative wrapper clips the selection too, so it
    // counts the same as a real scroll container.
    const clipsX = (style?.overflowX ?? "").split(/\s+/).some((v) => OVERFLOW_VALUES.has(v));
    const clipsY = (style?.overflowY ?? "").split(/\s+/).some((v) => OVERFLOW_VALUES.has(v));
    if (clipsX || clipsY) {
      const rect = node.getBoundingClientRect();
      if (clipsY) {
        bounds.top = Math.max(bounds.top, rect.top);
        bounds.bottom = Math.min(bounds.bottom, rect.bottom);
      }
      if (clipsX) {
        bounds.left = Math.max(bounds.left, rect.left);
        bounds.right = Math.min(bounds.right, rect.right);
      }
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
    }
    node = node.parentElement;
  }
  return bounds.bottom <= bounds.top ? null : bounds;
}

/**
 * Where the pill anchors: the selection's first client rect that is still
 * visible inside the bounds (a multi-line selection anchors to its top line),
 * falling back to the visible part of the whole bounding box.
 */
export function selectionQuoteAnchor({
  range,
  element,
  bounds,
}: {
  range: Range;
  element: Element;
  bounds: SelectionQuoteBounds;
}): SelectionQuoteRect | null {
  const rowRect = element.getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  for (const rect of rects) {
    const visible = intersectSelectionQuoteRect(rect, bounds);
    if (!visible) continue;
    if (rects.length > 1 || intersectSelectionQuoteRect(visible, rowRect)) {
      return visible;
    }
  }
  const bounding = range.getBoundingClientRect();
  const visibleBounding = intersectSelectionQuoteRect(bounding, bounds);
  if (visibleBounding && intersectSelectionQuoteRect(visibleBounding, rowRect)) {
    return visibleBounding;
  }
  if (rects.length > 0 || bounding.width > 0 || bounding.height > 0) return null;
  const rowVisible = intersectSelectionQuoteRect(rowRect, bounds);
  return rowVisible;
}

/**
 * Everything the pill renders from, or null when the selection is not one it
 * should own: no selection, a selection outside this transcript, a selection
 * that spans two rows, or an empty excerpt.
 */
export function selectionQuoteTarget({
  scrollRoot,
  bottomBoundaryTop,
  viewport = {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  },
}: {
  scrollRoot: Element | null;
  bottomBoundaryTop?: number | null;
  viewport?: { width: number; height: number };
}): SelectionQuoteTarget | null {
  const live = activeSelectionRange();
  if (!live || !scrollRoot) return null;

  const startRow = quotableRowFor(live.startContainer);
  // Both ends must sit in the same row: a drag that crosses rows has no single
  // message to attribute, and the reference implementation refuses it too.
  if (!startRow || startRow !== quotableRowFor(live.endContainer)) return null;
  if (!scrollRoot.contains(startRow)) return null;

  const rowAnchorId = startRow.getAttribute(QUOTABLE_ROW_ATTRIBUTE) ?? "";
  if (!rowAnchorId) return null;

  const range = clampRangeToElement(live, startRow);
  const markdown = serializeSelectionMarkdown(range);
  if (!markdown) return null;

  const bounds = selectionQuoteBounds({
    element: startRow,
    viewport,
    bottomBoundaryTop,
  });
  if (!bounds) return null;
  const anchor = selectionQuoteAnchor({ range, element: startRow, bounds });
  if (!anchor) return null;

  return {
    rowAnchorId,
    markdown,
    anchor,
    bounds,
    annotatable: isAnnotatableRow(startRow),
  };
}

/**
 * The Markdown of the current selection when it is inside `rowAnchorId`, and an
 * empty string otherwise — a selection in another row must not be attributed to
 * the message whose action row was clicked.
 */
export function selectionMarkdownWithinRow(
  rowAnchorId: string,
  container: Element | Document | null = null,
): string {
  const range = activeSelectionRange();
  if (!range) return "";
  const row = quotableRowFor(range.startContainer);
  if (!row || row.getAttribute(QUOTABLE_ROW_ATTRIBUTE) !== rowAnchorId) return "";
  if (container && !(container as Element).contains?.(row)) return "";
  return serializeSelectionMarkdown(range);
}
