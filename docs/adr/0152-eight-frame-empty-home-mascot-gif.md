# ADR 0152: Eight-frame empty-home mascot GIF

- Status: Accepted
- Date: 2026-09-04
- Deciders: PI-Desktop core
- Related: D293, D294, E2E-046, E2E-099, US-UI-17
- Supersedes: ADR 0150

## Context

ADR 0150 replaced a randomized pixel-art sprite atlas with a 100px inline SVG
agent mark so the empty-home hero stayed quiet. A new eight-frame waving
mascot is now the intended empty-home mark, with separate light and dark
artwork that already uses a transparent background. The previous SVG
orbit/breathe cycle no longer matches that artwork, and a single raster would
read poorly when the shell theme changes.

## Decision

Replace the inline SVG with processed eight-frame GIFs in the existing 100px
empty-home slot. `HomeMascotLogo` is decorative (`aria-hidden="true"`) and
renders four images, of which CSS shows one at a time:

- `src/assets/home-mascot-light.gif` / `home-mascot-dark.gif` — the looping
  wave, with a short idle hold on the first frame
- `src/assets/home-mascot-still-light.png` / `home-mascot-still-dark.png` —
  the matching first frame, shown only under `prefers-reduced-motion: reduce`

The active pair follows `document.documentElement[data-theme]`. Anything other
than `light` uses the dark artwork, matching `BrandLogo`. Playback is native
to the GIF. There is no random selection, no JavaScript timer, and pointer
hover does not change cadence.

## Consequences

- Empty-home branding uses the supplied mascot action set instead of a
  code-native SVG.
- The 100px layout slot, decorative role, and reduced-motion freeze remain.
- Light and dark surfaces each keep a dedicated mascot treatment instead of
  recoloring one asset through theme tokens.
- The historical `home-mascot-groups.png` atlas is not in the repository;
  the GIFs and still frames are the source assets.

## Alternatives rejected

- Keep the SVG and ignore the new frames: this would discard the requested
  empty-home action set.
- Restore the randomized sprite atlas: this would reintroduce timer, hover,
  and pose-selection state that ADR 0150 removed.
- Drive the eight frames from JavaScript: this would add timer and
  reduced-motion state the GIF plus CSS swap already cover.
- Use one GIF for both themes: the supplied light and dark artwork would
  clash with the opposite surface.
