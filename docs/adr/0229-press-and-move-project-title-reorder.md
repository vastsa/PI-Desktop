# ADR 0229: Press-and-move project title reorder

- Status: Accepted
- Date: 2026-09-11
- Amends: [ADR 0228](0228-long-press-project-title-reorder.md)
- Related: [D403](../spec/08-meta/decisions-log.md) · E2E-253

## Context

ADR 0228 armed the reorder drag after a still press, a mobile long-press
pattern that makes desktop sidebar reordering feel slower than product lists
that drag on immediate movement.

## Decision

The project title stays the reorder control with no grip, and pointer
disambiguation is movement instead of time. A pressed mouse or pen that moves
arms the drag; a click without qualifying movement still selects the project
and toggles collapse; touch presses never reorder, so one-finger panning
scrolls. An insertion line shows before/after placement from the pointer's
vertical midpoint, Escape cancels, and persistence and pin/archive buckets are
unchanged.

## Consequences

- Reorder reads as press, move, drop, like common sidebar lists.
- Touch scrolling survives an accidental pan on a title.
- The still-press contract in ADR 0228 is replaced.
