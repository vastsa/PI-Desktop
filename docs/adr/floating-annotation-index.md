# ADR floating-annotation-index: Floating Annotation Index and Source Locations

- Status: Superseded by ADR 0268
- Date: 2026-09-12
- Related: D209, D261, D301, D-LOCAL-response-annotations, D-LOCAL-selection-overlay,
  ADR response-annotations

## Context

A composer-only attachment list did not show where selections were made, and inserting
marker text into Markdown had already broken words, selections, and formulas.

## Decision

One floating annotation index above the composer in the visible transcript pane listed
numbered excerpts with comments, locate, edit, remove, and clear-all controls in the
same one-based order as source badges and the prompt payload, with each saved resolvable
selection highlighted by a non-interactive overlay outside the answer DOM. A
renderer-only optional anchor stored start and end offsets plus exact answer text,
excluding code chrome, KaTeX's duplicate MathML, and citation markers, relocating a
shifted selection only when its exact text was unique, and deduplication keyed on source
row, excerpt, and offsets so equal words at distinct locations stayed separate. Protocol
v11 and schema v15 were preserved.

## Consequences

- Selections were locatable from one panel instead of a composer list.
- ADR 0268 retired the surface; the stored anchor fields stay readable.
