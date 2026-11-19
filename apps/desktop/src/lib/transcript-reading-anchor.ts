const BLOCKS = ".prose-chat p, .prose-chat li, .prose-chat pre, .prose-chat h1, .prose-chat h2, .prose-chat h3, .message-user-text";

export type TranscriptTextAnchor = {
  element: HTMLElement;
  sourceStart?: string;
  sourceEnd?: string;
  text: string;
  textOffset?: number;
  offset: number;
};

/** Own repairs update previousTop synchronously. A shrinking legal range can
 * move that position without input; only movement beyond that clamp is reading. */
export function transcriptReaderMovement(previousTop: number, top: number, height: number, viewport: number) {
  const clampedPrevious = Math.min(Math.max(0, previousTop), Math.max(0, height - viewport));
  return top - clampedPrevious;
}

function characterRange(node: Text, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(node.length, offset + 1));
  return range;
}

function textRect(element: HTMLElement, offset: number): DOMRect | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (offset < text.length) return characterRange(text, offset).getBoundingClientRect();
    offset -= text.length;
  }
}

/** Capture a visible character, not just the top of a potentially huge paragraph.
 * Tree walking is limited to the single visible block, never the whole history. */
function visibleCharacter(element: HTMLElement, viewport: DOMRect) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let preceding = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const range = document.createRange();
    range.selectNodeContents(text);
    const visible = [...range.getClientRects()].some(rect => rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom);
    if (visible && text.length) {
      let low = 0;
      let high = text.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (characterRange(text, middle).getBoundingClientRect().bottom > viewport.top) high = middle;
        else low = middle + 1;
      }
      const rect = characterRange(text, low).getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        return { textOffset: preceding + low, rect };
      }
    }
    preceding += text.length;
  }
}

export function captureTranscriptTextAnchor(scroller: HTMLElement, row: HTMLElement | null): TranscriptTextAnchor | undefined {
  const viewport = scroller.getBoundingClientRect();
  for (const element of row?.querySelectorAll<HTMLElement>(BLOCKS) ?? []) {
    const block = element.getBoundingClientRect();
    if (block.height <= 0 || block.bottom <= viewport.top || block.top >= viewport.bottom) continue;
    const character = visibleCharacter(element, viewport);
    return { element, sourceStart: element.dataset.sourceStart, sourceEnd: element.dataset.sourceEnd,
      text: element.textContent ?? "", textOffset: character?.textOffset,
      offset: (character?.rect ?? block).top - viewport.top };
  }
}

/** Parser range + exact rendered text guards against reusing offsets after an
 * edit. The element is only a cache: unchanged Markdown can be reconstructed. */
export function resolveTranscriptTextAnchor(row: HTMLElement | null, point: TranscriptTextAnchor): DOMRect | undefined {
  if (!row) return;
  let element = point.element;
  if (!row.contains(element)) {
    if (point.sourceStart === undefined || point.sourceEnd === undefined) return;
    const selector = `${element.tagName.toLowerCase()}[data-source-start="${CSS.escape(point.sourceStart)}"][data-source-end="${CSS.escape(point.sourceEnd)}"]`;
    const replacement = [...row.querySelectorAll<HTMLElement>(selector)].find(candidate => candidate.textContent === point.text);
    if (!replacement) return;
    element = replacement;
  }
  if (element.dataset.sourceStart !== point.sourceStart || element.dataset.sourceEnd !== point.sourceEnd || element.textContent !== point.text) return;
  point.element = element;
  const rect = point.textOffset === undefined ? element.getBoundingClientRect() : textRect(element, point.textOffset);
  return rect && rect.height > 0 ? rect : undefined;
}
