# ADR 0071: Adopt an Apple-Inspired Global Corner Hierarchy

- Status: Accepted for implementation
- Date: 2026-08-11
- Deciders: PI-Desktop core
- Related: D072, D210

## Context

PI-Desktop enforced a shared radius-token scale, but that scale preserved a
collection of historical 5/6/7/8/10/12/14/16/18/22px values. The one-pixel steps
at the compact end were difficult to distinguish, and the shared button
primitive used a capsule even though most of its 28–32px actions belong to a
dense desktop interface.

## Decision

1. Replace the fixed-radius ladder with 4/6/8/10/12/14/16/18/20/24px values.
2. Standard compact and medium controls use fixed rounded rectangles.
3. Pills, badges, segmented selections, switches, tracks, status dots, and
   equal-width circular icon controls keep their explicit capsule or circle
   geometry.
4. Surfaces increase radius with size and elevation.
5. Full-width structural shell surfaces remain square at the window edge.
6. The composer aliases its established 20px radius to `--radius-xl`, keeping
   the visible composer geometry while bringing it into the global ladder.
7. D072's token-only lint enforcement remains unchanged; only the frozen pixel
   values and shared primitive assignments are amended.

## Consequences

- The interface has a more legible small-to-large corner hierarchy, while
  compact macOS controls no longer look uniformly pill-shaped.
- Existing token consumers receive the revised values globally without
  component-local literals.
- Designers and implementers must choose pill or circle tokens intentionally
  instead of treating them as a default radius.
- True continuous-corner rendering remains unavailable until the packaged
  Chromium runtime supports `corner-shape`; the compatible fallback is the
  standardized fixed-radius ladder.

## Alternatives considered

### Make every component a capsule

Rejected because Apple retains rounded rectangles for compact macOS controls and
uses capsules selectively for emphasis and specific control families.

### Add `corner-shape: squircle` now

Rejected because the packaged Chromium 138 runtime does not support it.

### Keep the historical values and change individual components

Rejected because the request is global, and retaining closely spaced 5/6/7/8px
steps would continue to make the hierarchy hard to perceive and maintain.

## Addendum (2026-08-14): the `corner-shape` blocker is gone

The Context and Alternatives above are left as recorded. Their runtime premise
no longer holds: the shell moved to Electron 43, which bundles Chromium 150, and
`CSS.supports("corner-shape", "squircle")` returns `true` in the packaged
renderer.

This addendum does not change the decision. The fixed-radius ladder stays as
specified; adopting continuous corners is a design change that needs its own
decision, not a side effect of a dependency bump.
