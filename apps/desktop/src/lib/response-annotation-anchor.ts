import { activeSelectionRange, expandRangeToWholeKatex, quotableRowFor } from "./selection-quote";

/** Renderer-only offsets in the answer's text nodes, never in prompt payloads. */
export type ResponseAnnotationAnchor = { start: number; end: number; exact: string };

/** Resolve the original occurrence; relocate only when its text is unambiguous. */
export function resolveAnnotationOffsets(text: string, anchor: ResponseAnnotationAnchor) {
  if (anchor.start >= 0 && anchor.end > anchor.start &&
      text.slice(anchor.start, anchor.end) === anchor.exact) {
    return { start: anchor.start, end: anchor.end };
  }
  if (!anchor.exact) return null;
  const start = text.indexOf(anchor.exact);
  if (start < 0 || text.indexOf(anchor.exact, start + 1) !== -1) return null;
  return { start, end: start + anchor.exact.length };
}

function answerTextNodes(row: Element): Text[] {
  const walker = row.ownerDocument.createTreeWalker(row, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent || !parent?.closest(".prose-chat") ||
        parent.closest(".code-block-head, .katex-mathml, .response-annotation-marker, [data-annotation-layer]")) continue;
    nodes.push(node as Text);
  }
  return nodes;
}

export function captureAnnotationAnchor(row: Element, selection: Range): ResponseAnnotationAnchor | undefined {
  if (!row.contains(selection.startContainer) || !row.contains(selection.endContainer)) return;
  const range = expandRangeToWholeKatex(selection);
  const nodes = answerTextNodes(row);
  let offset = 0;
  let start = -1;
  let end = -1;
  for (const node of nodes) {
    if (range.intersectsNode(node)) {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      if (to > from) {
        if (start < 0) start = offset + from;
        end = offset + to;
      }
    }
    offset += node.length;
  }
  if (start < 0 || end <= start) return;
  return { start, end, exact: nodes.map((node) => node.data).join("").slice(start, end) };
}

export function selectionAnnotationAnchorWithinRow(rowId: string): ResponseAnnotationAnchor | undefined {
  const range = activeSelectionRange();
  const row = range && quotableRowFor(range.startContainer);
  if (!range || !row || row.getAttribute("data-minimap-id") !== rowId) return;
  return captureAnnotationAnchor(row, range);
}

/** A failed resolution is deliberately a row-level fallback, not a guessed pass. */
export function annotationRange(row: Element, anchor?: ResponseAnnotationAnchor): Range | null {
  if (!anchor) return null;
  const nodes = answerTextNodes(row);
  const offsets = resolveAnnotationOffsets(nodes.map((node) => node.data).join(""), anchor);
  if (!offsets) return null;
  const range = row.ownerDocument.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const next = offset + node.length;
    if (!started && offsets.start < next) {
      range.setStart(node, offsets.start - offset);
      started = true;
    }
    if (started && offsets.end <= next) {
      range.setEnd(node, offsets.end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}

export function annotationRow(root: Element, messageId: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-row-role="assistant"][data-minimap-id]'))
    .find((row) => row.dataset.minimapId === messageId);
}

/** Stack coincident badges without changing the answer's layout. */
export function placeAnnotationBadges<T extends { top: number }>(badges: T[], top: number, bottom: number, size = 22) {
  let nextTop = top;
  return [...badges].sort((a, b) => a.top - b.top).map((badge) => {
    const placed = { ...badge, top: Math.max(nextTop, badge.top) };
    nextTop = placed.top + size + 3;
    return placed;
  }).filter((badge) => badge.top + size <= bottom);
}
