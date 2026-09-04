# ADR 0150: Inline SVG empty-home agent mark

- Status: Superseded by ADR 0152
- Date: 2026-09-04
- Deciders: PI-Desktop core
- Related: D291, E2E-046, E2E-099, US-UI-17

## Context

The empty-home hero used a raster sprite atlas with randomized pose groups,
discrete frame changes, and a hover shortcut that accelerated playback. The
result was visually loud in the central conversation area and added asset,
timer, and reduced-motion state to a decorative mark.

## Decision

Replace the sprite with a 100px inline SVG agent mark. A thin orbit and signal
point rotate slowly around a compact core; the core breathes gently and the
eyes blink occasionally. The animation is deterministic, pointer hover does
not change its cadence, and `prefers-reduced-motion: reduce` freezes the mark.
The SVG remains decorative with `aria-hidden="true"` and preserves the existing
100px layout slot.

## Consequences

- Empty-home branding is quieter and remains readable across light and dark
  themes through semantic color tokens.
- The component has no raster atlas, random selection, timers, or hover state.
- CSS owns the motion and can disable it without changing the rendered SVG.
- The old sprite asset can remain available for historical source context but
  is no longer part of the renderer path.

## Alternatives rejected

- Keep the existing atlas and tune pause durations: this would retain the
  visually noisy pixel-art treatment and interaction-specific timer state.
- Generate another raster mascot: this would add asset maintenance while
  preserving the same theme and reduced-motion limitations.
