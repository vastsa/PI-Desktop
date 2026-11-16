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
with denser chrome and larger headings). The application menu exposes Zoom In /
Zoom Out / Reset Zoom, but those scale the entire window, including layout and
controls.

## Decision

1. **Settings → General → Appearance** gains a **Font size** row under Font.

2. **Persistence** is optional `AppSettings.fontScale` (`1` = product ramp).

3. **Application** is global.

4. **Zoom stays independent.** Menu and shortcut Zoom In / Zoom Out / Reset Zoom
   continue to scale the whole window.

## Consequences

- One control scales every `--text-*` consumer; places that are already smaller
  or larger than body stay relatively smaller or larger.
- Users do not pick a px number that only matches `--text-base`.
- Large scales also enlarge compact chrome, including Lucide glyphs.

## Alternatives

- **Reading-only remap of `.thread-wrap` / `.composer-dock`:** keeps chrome
  compact, but users then have two type sizes in one window and still need a px
  number for the body step.
- **Zoom In/Out only:** already exists; it scales chrome together with text and
  is not a type preference.
- **Change `html { font-size }` and switch the ramp to rem:** larger refactor;
  the product ramp is px tokens and the token guard forbids raw rem in component
  CSS.
