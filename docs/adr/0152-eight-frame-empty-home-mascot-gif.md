# ADR 0152: Eight-frame empty-home mascot GIF

- Status: Accepted
- Date: 2026-09-04
- Related: D293, D294
- Supersedes: ADR 0150

## Context

ADR 0150 made the empty-home hero a quiet inline SVG mark. The intended mark is
now an eight-frame waving mascot with separate light and dark artwork on a
transparent background, which does not match the SVG orbit cycle and would read
badly as one recolored raster under a theme change.

## Decision

Replace the inline SVG with processed eight-frame GIFs in the existing 100px
empty-home slot. `HomeMascotLogo` is decorative (`aria-hidden="true"`) and renders
four images, of which CSS shows one: the light and dark GIF loops, or their
matching first-frame stills under `prefers-reduced-motion: reduce`. The active
pair follows `document.documentElement[data-theme]`, with anything other than
`light` using the dark artwork like `BrandLogo`. Playback is native to the GIF,
with no random selection, JavaScript timer, or hover-dependent cadence.

## Consequences

- Branding uses the supplied mascot action set instead of code-native artwork.
- The layout slot, decorative role, and reduced-motion freeze remain.
- Each theme keeps dedicated artwork rather than recoloring one asset.

## Alternatives

- Drive the frames from JavaScript: rejected because GIF plus CSS already covers
  playback and reduced motion without extra timer state.
- Use one GIF for both themes: rejected because the supplied artwork would clash
  with the opposite surface.
