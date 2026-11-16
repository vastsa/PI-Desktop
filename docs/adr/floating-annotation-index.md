# ADR floating-annotation-index: Floating Annotation Index and Source Locations
> Superseded by ADR 0268.

- Status: Superseded by ADR 0268
- Date: 2026-09-12
- Amends: ADR response-annotations / D-LOCAL-response-annotations (annotation presentation and duplicate identity)
- Preserves: D209, D301, D261, D-LOCAL-selection-overlay; protocol v11 and schema v15

## Context

The comment editor solved missing comment entry, but a composer-only attachment
list did not show where selections were made.

## Decision

1. Replace the composer attachment popover with one floating annotation index in
   the visible, writable transcript pane, above the composer. It starts
   expanded, collapses to its count header, and stays open during reading.

## Consequences

Superseded (Superseded by ADR 0268). The full record is in git history.
