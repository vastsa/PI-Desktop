# ADR 0180: Custom global UI type scale

- Status: Accepted (amended)
- Date: 2026-09-08
- Related: D343, ADR 0083, `04-ux/06-settings-ia.md`

## Context

The `--text-*` ramp is a frozen set of product sizes, and Zoom In / Zoom Out scale
the whole window including layout and controls, so a user who wants denser or
larger type had no remembered preference that keeps body, chrome, and headings in
proportion. An earlier draft remapped only the transcript and composer from a px
value, which left other surfaces at product size.

## Decision

1. **Settings → General → Appearance** gains a **Font size** row under Font, with
   four cup presets (Tall 85% / Grande 100% / Venti 115% / Trenta 125%) above a
   percentage slider; valid values are 80%–150% in 2.5% steps, and absent means
   100%.
2. **Persistence** is the optional `AppSettings.fontScale`, rejected at the
   renderer edge on invalid writes and clamped through `normalizeFontScale` on
   read, with no protocol or schema version bump.
3. **Application** is global: the renderer sets `--font-scale` on
   `document.documentElement`, every `--text-*` token and `--leading-row` becomes
   `calc(<product px> * var(--font-scale))`, and shared Lucide wrappers scale
   glyphs the same way.
4. **Zoom stays independent** and composes with the type scale.

## Consequences

- One control scales every `--text-*` consumer while keeping relative steps.
- Users choose a scale, never a px number that only matches `--text-base`.
- Compact chrome grows too, so rows with a fixed px height may feel tighter; the
  150% cap bounds that.

## Alternatives

- Remap only `.thread-wrap` and `.composer-dock` — rejected: two type sizes in one
  window, and a px number is still required.
- Use Zoom In/Out as the type preference — rejected: it scales layout with text.
