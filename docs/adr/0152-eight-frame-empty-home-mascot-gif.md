# ADR 0152: Eight-frame empty-home mascot GIF

- Status: Accepted
- Date: 2026-09-04
- Deciders: PI-Desktop core
- Related: D293, D294, E2E-046, E2E-099, US-UI-17
- Supersedes: ADR 0150

## Context

ADR 0150 replaced a randomized pixel-art sprite atlas with a 100px inline SVG
agent mark so the empty-home hero stayed quiet. The empty-home mark now uses
transparent animated artwork, with dedicated light and dark variants. Chinese
locales have a separate dark variant supplied as a 30-frame GIF; the standard
light and dark variants remain eight-frame waves.

## Decision

Keep `HomeMascotLogo` in the existing 100px empty-home slot. It is decorative
(`aria-hidden="true"`) and renders six images, of which CSS shows one at a
time:

- `src/assets/home-mascot-light.gif` / `home-mascot-dark.gif` — the standard
  eight-frame wave, with a short idle hold on the first frame
- `src/assets/home-mascot-dark-zh.gif` — the supplied transparent 30-frame
  artwork for Chinese locales in dark mode
- The three matching still PNGs — the first frame for each artwork, shown only
  under `prefers-reduced-motion: reduce`

Theme selection follows `document.documentElement[data-theme]`; language
selection follows its `lang` attribute. Anything other than `light` uses dark
artwork, and `lang` values beginning with `zh` select the Chinese dark
variant. Playback is native to the GIF. There is no random selection, no
JavaScript timer, and pointer hover does not change cadence.

## Consequences

- Empty-home branding uses the supplied mascot action set instead of a
  code-native SVG.
- The 100px layout slot, decorative role, and reduced-motion freeze remain.
- Light and dark surfaces keep dedicated artwork. Chinese dark mode uses the
  supplied Chinese action set, while other locales retain the existing dark
  wave.
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
