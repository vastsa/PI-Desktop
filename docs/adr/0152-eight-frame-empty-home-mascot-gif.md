# ADR 0152: Eight-frame empty-home mascot GIF

- Status: Accepted
- Date: 2026-09-04
- Deciders: PI-Desktop core
- Related: D293, E2E-046, E2E-099, US-UI-17
- Supersedes: ADR 0150

## Context

ADR 0150 replaced a randomized pixel-art sprite atlas with a 100px inline SVG
agent mark so the empty-home hero stayed quiet. A new eight-frame waving
mascot is now the intended empty-home mark. The previous SVG orbit/breathe
cycle no longer matches that artwork, and restoring the old atlas would bring
back random pose selection, timers, and hover-driven playback.

## Decision

Replace the inline SVG with a processed eight-frame GIF in the existing 100px
empty-home slot. `HomeMascotLogo` is decorative (`aria-hidden="true"`) and
renders two images:

- `src/assets/home-mascot.gif` — the looping wave, with a short idle hold on
  the first frame
- `src/assets/home-mascot-still.png` — the first frame, shown only under
  `prefers-reduced-motion: reduce`

Playback is native to the GIF. There is no random selection, no JavaScript
timer, and pointer hover does not change cadence. Reduced motion swaps to the
still PNG through CSS.

## Consequences

- Empty-home branding uses the supplied mascot action set instead of a
  code-native SVG.
- The 100px layout slot, decorative role, and reduced-motion freeze remain.
- Theme tokens no longer recolor the mark; the artwork keeps its original
  black outline and light fill so it stays readable on light and dark
  surfaces.
- The historical `home-mascot-groups.png` atlas stays out of the renderer
  path.

## Alternatives rejected

- Keep the SVG and ignore the new frames: this would discard the requested
  empty-home action set.
- Restore the randomized sprite atlas: this would reintroduce timer, hover,
  and pose-selection state that ADR 0150 removed.
- Drive the eight frames from JavaScript: this would add timer and
  reduced-motion state the GIF plus CSS swap already cover.
