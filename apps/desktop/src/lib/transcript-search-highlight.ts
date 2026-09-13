import { searchMatchRanges } from "./session-search";

/** Match across Markdown's inline elements without rewriting React-owned DOM. */
export function transcriptSearchRanges(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("button:not(.chat-text-link):not(.chat-file-chip), textarea, [aria-hidden='true']")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.textContent ?? "";
    nodes.push({ node: node as Text, start, end: text.length });
  }
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
