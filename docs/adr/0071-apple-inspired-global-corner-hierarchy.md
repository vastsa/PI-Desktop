# ADR 0071: Adopt an Apple-Inspired Global Corner Hierarchy

- Status: Accepted for implementation
- Date: 2026-08-11
- Related: D072, D210

## Context

The shared radius-token scale preserved historical values whose one-pixel steps at
the compact end were hard to distinguish, and the shared button primitive used a
capsule even though most actions belong to a dense desktop interface. Apple's
guidance separates fixed rounded rectangles, capsules, and concentric shapes and
derives a child radius from its container, which matters more than one radius
applied everywhere. The packaged Chromium runtime could not render
`corner-shape: squircle`.

## Decision

Replace the fixed-radius ladder with a coarser, evenly perceivable scale while
keeping `--radius-full` for capsules and `--radius-round` for circles. Compact and
medium controls use fixed rounded rectangles, with the shared button and field
primitives on `--radius-sm`; pills, badges, segmented selections, switches, tracks,
status dots, and circular icon controls keep their explicit capsule or circle
geometry. Surfaces increase radius with size and elevation, a child corner near and
parallel to a container corner follows the concentric relation
`outer radius = inner radius + inset`, and full-width structural shell surfaces stay
square at the window edge. The composer aliases its established radius to
`--radius-xl`, and D072's token-only lint enforcement is unchanged.

## Consequences

- Small-to-large corners read as one hierarchy instead of a pill default.
- Token consumers pick up the revised values globally, without component literals.
- Continuous corners stay deferred: the 2026-08-14 addendum records that later
  Chromium packaging removed the runtime blocker without changing this decision.

## Alternatives

- Make every component a capsule: rejected because Apple keeps rounded rectangles
  for compact controls and reserves capsules for emphasis.
- Keep historical values and change components individually: rejected because the
  change is global and the close steps stay imperceptible.
