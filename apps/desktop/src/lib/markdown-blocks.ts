import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

// Share the grammar with ReactMarkdown. A different block lexer can split a
// valid math node at a list, quote, heading, or blank line inside its TeX.
//
// "Share" is literal and rests on deduplication: `react-markdown` depends on
// `remark-parse`/`unified` itself, and the ranges in `package.json` are kept
// wide enough to overlap its own so the installer resolves one copy for both.
// Pinning either exactly is the one way to break that — the renderer's range
// still floats, and the two would then parse blocks by different grammars
// while every test keeps passing, which is the defect this module exists to
// remove. If `react-markdown` ever moves to a new major of either, follow it
// rather than holding this one back.
//
// The parse costs more per byte than the `marked` lexer it replaces, and the
// cost lands on the render path. It is not the frame's dominant term: normal
// multi-block streaming re-parses only a short tail (~0.1 ms/frame), and the
// one shape whose tail is the whole message — a single long unclosed fence —
// measures ~2.4 ms/frame at 46 KB, on top of the full parse ReactMarkdown
// already runs over that same tail each frame. The quadratic shape belongs to
// incremental splitting itself and predates this parser.
//
// Guarding the tail parse behind a cheap "could this append have opened a
// boundary?" test is refused rather than merely unwritten: such a test is a
// second block grammar, and a second block grammar disagreeing with the
// renderer's is the defect this module exists to remove. Throttling streaming
// renders, or reading boundaries from micromark's own events, would cut the
// cost without buying it back.
export const markdownRemarkPlugins = [remarkGfm, remarkMath];
const parser = unified().use(remarkParse).use(markdownRemarkPlugins);

export type MarkdownBlockSplit = {
  /** Source slices that concatenate back to the input. */
  blocks: string[];
  /**
   * The source declares a link or footnote definition, so its slices cannot
   * be parsed independently of each other. See `advanceMarkdownBlocks`.
   */
  hasDocumentScopedDefinition: boolean;
};

/*
 * A definition resolves across the whole document rather than inside its own
 * container: `> [ref]: /url` in a quote still defines `[ref]` for a later
 * paragraph. The search descends for that reason instead of reading the top
 * level, where such a definition never appears as a child.
 */
function declaresDefinition(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const { type, children } = node as { type?: unknown; children?: unknown };
  if (type === "definition" || type === "footnoteDefinition") return true;
  return Array.isArray(children) && children.some(declaresDefinition);
}

export function parseMarkdownBlocks(source: string): MarkdownBlockSplit {
  if (!source) return { blocks: [], hasDocumentScopedDefinition: false };
  const root = parser.parse(source);
  const blocks: string[] = [];
  let start = 0;
  for (const node of root.children.slice(1)) {
    const nodeStart = node.position?.start.offset;
    if (nodeStart === undefined) {
      // `remark-parse` positions everything it produces, and only a plugin
      // that synthesizes a node can leave the offset out — which is why mdast
      // keeps `position` optional at all. Unreachable for the parser-level
      // plugins above, and handled anyway for what it would cost: this runs
      // in `Markdown`'s render memo, under the app's single root
      // `ErrorBoundary`, so a throw here replaces the whole window. An
      // undivided source renders identically and only gives up per-block
      // memoization — the same cost `advanceMarkdownBlocks` already accepts
      // for a definition — so degrading is strictly better than failing.
      console.warn("Markdown block has no source offset; rendering undivided");
      return {
        blocks: [source],
        hasDocumentScopedDefinition: declaresDefinition(root),
      };
    }
    // Slice the original bytes, including CRLF and inter-block whitespace.
    // Attaching whitespace to the preceding block keeps source anchors and
    // the streaming tail's start aligned without serializing the AST again.
    //
    // Cut at the line start rather than at `nodeStart`: the grammar is
    // line-based, so a block owns the indentation before its first character
    // while `position.start` points past it. A slice that loses those columns
    // re-parses as a different block — two items indented by two spaces become
    // a nested list, and an indented fence keeps the indent inside its code. No
    // two top-level blocks begin on the same line, so the span skipped here is
    // whitespace and the slices still concatenate back to the source.
    const end = source.lastIndexOf("\n", nodeStart - 1) + 1;
    blocks.push(source.slice(start, end));
    start = end;
  }
  blocks.push(source.slice(start));
  return { blocks, hasDocumentScopedDefinition: declaresDefinition(root) };
}

export type MarkdownBlockCache = {
  /** Source the cached blocks were produced from. */
  consumed: string;
  blocks: string[];
  /** The cached blocks are the whole source, kept undivided on purpose. */
  singleUnit: boolean;
};

export const emptyMarkdownBlockCache: MarkdownBlockCache = {
  consumed: "",
  blocks: [],
  singleUnit: false,
};

/*
 * Split `source` for rendering, reusing what `cache` already settled.
 *
 * A slice may be handed to its own parser only when it needs no other slice's
 * parse context. Definitions break that: they resolve document-wide, and
 * footnotes additionally carry document-wide numbering, reuse and back-links.
 * A source that declares one therefore stays undivided. Copying definitions
 * into every slice is no substitute — it renumbers footnotes per slice and
 * aims the back-links at the wrong reference, and even for a plain link
 * definition, where no numbering is at stake, it breaks the property every
 * caller relies on: the slices concatenate back to the source, which is what
 * keeps each block's `data-source-*` offsets pointing at real bytes.
 *
 * The cost is accepted, not overlooked, and it is a cost rather than a
 * limitation carried over: marked's lexer did split these sources, so this
 * gives that split up on purpose. Such a source loses per-slice memoization
 * and re-parses in full on every streaming frame, the way the renderer did
 * before it split blocks at all, and the frame that collapses N slices into
 * one remounts them, re-rendering Mermaid, Shiki and KaTeX. What the old
 * split bought was speed on a wrong rendering: definitions are rare in chat
 * answers, and a reference that survives as a literal `[^1]` is wrong at any
 * frequency.
 *
 * Rare is measured against the grammar rather than against the shape of the
 * line, which is most of the answer to "but surely ordinary prose trips
 * this". A definition needs its destination to end the line bar an optional
 * quoted or parenthesised title, so a glossary line reading
 * `[API]: Application Programming Interface` is a paragraph — those trailing
 * words are not a valid title. What reaches this branch is a real
 * reference-style link or footnote, which is the case the branch is for.
 *
 * Streaming keeps the settled prefix and re-parses only the tail, which still
 * observes every definition: a block only ever comes into existence through a
 * tail parse, so a definition anywhere in the source was seen by the parse
 * that first produced its block, and `singleUnit` latches that observation for
 * the rest of the append run. The latch is one-way by choice, not because a
 * definition is permanent: appending to a definition's own line can take it
 * back — `[spec]: /url` continued into `[spec]: /url is the reference.` is a
 * plain paragraph — and such a source stays undivided for the rest of the run
 * anyway. Undivided is always a correct rendering, so a stale latch costs
 * speed and never output, while re-deciding would parse the whole source on
 * every frame to win a split back for a message that read like a definition
 * once. A source that stops extending the cached one is an edit rather than an
 * append, and decides again from a full parse.
 *
 * Splitting an undivided source is still wrong for raw HTML that wraps
 * blank-line-separated Markdown (`<div>` … `</div>`), whose tags land in
 * different slices unbalanced. That is not a definition problem, it predates
 * this splitter — marked's lexer separated those tags the same way — and it
 * is deliberately left alone here.
 */
export function advanceMarkdownBlocks(
  cache: MarkdownBlockCache,
  source: string,
): MarkdownBlockCache {
  const appended =
    cache.blocks.length > 0 &&
    source.length >= cache.consumed.length &&
    source.startsWith(cache.consumed);
  // Latched one-way; see above for why a stale latch costs speed, not output.
  if (appended && cache.singleUnit) {
    return { consumed: source, blocks: [source], singleUnit: true };
  }
  let stable: string[] = [];
  let tail = source;
  if (appended) {
    stable = cache.blocks.slice(0, -1);
    const lastStart =
      cache.consumed.length - cache.blocks[cache.blocks.length - 1].length;
    tail = source.slice(lastStart);
  }
  // An unclosed math fence owns its entire body, including blank lines, so no
  // interior list or quote is mistaken for a completed streaming boundary.
  const split = tail
    ? parseMarkdownBlocks(tail)
    : { blocks: [], hasDocumentScopedDefinition: false };
  const singleUnit = split.hasDocumentScopedDefinition;
  const blocks = singleUnit ? [source] : [...stable, ...split.blocks];
  return { consumed: source, blocks, singleUnit };
}
