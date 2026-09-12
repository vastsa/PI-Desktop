# ADR 0180: Custom global UI type scale

- Status: Accepted (amended)
- Date: 2026-09-08
- Baseline: `0.4.16`
- Protocol: unchanged (renderer-owned `AppSettings` JSON field)
- Storage schema: unchanged (optional `AppSettings.fontScale`)
- Related: D343, ADR 0083, `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md`

## Context

The `--text-*` ramp is a frozen set of product sizes (`--text-base` is 14px,
with denser chrome and larger headings). The application menu exposes Zoom
In / Zoom Out / Reset Zoom, but those scale the entire window, including
layout and controls. Users who want denser or larger type have no remembered
preference that keeps the relative steps between body, chrome, and headings.

An earlier draft of this decision stored a reading-only px value and remapped
only the transcript and composer. That left sidebar and settings at the
product size, required the user to pick a px number, and did not scale
surfaces that already use different steps of the same ramp.

## Decision

1. **Settings → General → Appearance** gains a **Font size** row under Font.
   Four Starbucks-style cup presets (Tall 85% / Grande 100% / Venti 115% /
   Trenta 125%; zh-CN: 中杯 / 大杯 / 超大杯 / 超超大杯) sit above a
   percentage slider. Valid values are 80%–150% in 2.5% steps. Absent means
   100%. The UI never asks for a px value.

2. **Persistence** is optional `AppSettings.fontScale` (`1` = product ramp).
   Invalid writes are rejected at the renderer edge; reads clamp through
   `normalizeFontScale`. An unreleased leftover `fontSize` px field, if
   present without `fontScale`, migrates as `px / 14`. No host protocol or
   storage schema version bump.

3. **Application** is global. The renderer sets `--font-scale` on
   `document.documentElement`. Every `--text-*` token and `--leading-row`
   is `calc(<product px> * var(--font-scale))`, so body, chrome, headings,
   code, sidebar, and settings stay in proportion without a reload. Shared
   Lucide wrappers size glyphs with `calc(<px> * var(--font-scale))` so
   toolbar, sidebar, composer, and settings icons track the same multiplier.

4. **Zoom stays independent.** Menu and shortcut Zoom In / Zoom Out / Reset
   Zoom continue to scale the whole window. Type scale and zoom compose.

## Consequences

- One control scales every `--text-*` consumer; places that are already
  smaller or larger than body stay relatively smaller or larger.
- Users do not pick a px number that only matches `--text-base`.
- Large scales also enlarge compact chrome, including Lucide glyphs. Rows
  whose height is a fixed px value (not `--leading-row`) may still feel
  tighter; the 150% cap bounds that.

## Alternatives

- **Reading-only remap of `.thread-wrap` / `.composer-dock`:** keeps chrome
  compact, but users then have two type sizes in one window and still need
  a px number for the body step.
- **Zoom In/Out only:** already exists; it scales chrome together with text
  and is not a type preference.
- **Change `html { font-size }` and switch the ramp to rem:** larger
  refactor; the product ramp is px tokens and the token guard forbids raw
  rem in component CSS.
