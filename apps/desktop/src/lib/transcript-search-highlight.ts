import { searchMatchRanges } from "./session-search";

const NON_CONTENT = "button:not(.chat-text-link):not(.chat-file-chip):not(.chat-code-link), textarea, [aria-hidden='true']";

function textNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(NON_CONTENT)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.textContent ?? "";
    nodes.push({ node: node as Text, start, end: text.length });
  }
  return { nodes, text };
}

/** Match across Markdown's inline elements without rewriting React-owned DOM. */
export function transcriptSearchRanges(root: HTMLElement, query: string): Range[] {
  const { nodes, text } = textNodes(root);
  return searchMatchRanges(text, query).flatMap(([start, end]) => {
    const first = nodes.find((part) => part.end > start);
    const last = nodes.find((part) => part.end >= end && part.start < end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return [range];
  });
}

export type TranscriptSearchMatch = {
  ranges: Range[];
  /** A source-only match highlights its rendered element, such as a link label. */
  sourceElement?: HTMLElement;
};

/** The parser maps hidden Markdown syntax and destinations to their visible owner. */
export function locateTranscriptSearch(
  root: HTMLElement,
  query: string,
  source: string,
): TranscriptSearchMatch {
  const first = searchMatchRanges(source, query)[0];
  let owner: HTMLElement | undefined;
  let ownerLength = Infinity;
  if (first) {
    for (const element of root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")) {
      const start = Number(element.dataset.sourceStart);
      const end = Number(element.dataset.sourceEnd);
      if (start <= first[0] && end >= first[1] && end - start < ownerLength) {
        owner = element;
        ownerLength = end - start;
      }
    }
  }
  const ranges = transcriptSearchRanges(owner ?? root, query);
  if (ranges.length || !owner) return { ranges };
  // Link URLs, emphasis delimiters, and image destinations have no literal
  // rendered text. Their source owner is still a precise, visible destination.
  return { ranges: [], sourceElement: owner };
}
