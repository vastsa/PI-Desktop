# ADR 0125: Renderer Ships Derived Brand Marks and Minified Output

- Status: Accepted
- Date: 2026-08-26
- Related: ADR 0083, D079, D094
- Baseline: `0.10.8`

## Context

The renderer output was 31 MiB, and three of its costs were accidental rather
than product decisions:

1. `electron-vite` hard-defaults its renderer preset to `minify: false`, unlike
   plain Vite.
2. KaTeX's stylesheet declares `woff2`, `woff`, and `truetype` sources for each
   of its faces.
3. D079 and D094 named `build/icon_1024.png` as the canonical brand mark, and
   `BrandLogo` imported it directly.

## Decision

1. The renderer build sets `minify: "esbuild"` explicitly.
2. A `pi-drop-legacy-font-fallbacks` Vite plugin removes `woff` and `truetype`
   `src` entries from CSS with `enforce: "pre"`, before Vite registers `url()`
   values as assets.
3. `build/icon_1024.png` and `build/logo_dark.png` remain the canonical brand
   masters and the source of truth for installer icons.

*(Superseded by [ADR 0298](0298-remove-bundled-fonts.md): the app ships no
fonts, so there is nothing to subset.)* The two bundled CJK faces stayed
unsubset while they existed. ADR 0083 section 2 appended `Noto Sans SC` to every
font stack so Chinese text stayed readable offline, and subsetting would have
dropped glyphs from user-supplied content; reducing those 15 MiB required
revising ADR 0083, not a build-config change.

## Consequences

- `out/renderer` drops from 31 MiB to 24 MiB: JavaScript 12.53 to 7.72 MiB,
  legacy font fallbacks 0.78 MiB to 0, PNG brand assets 1.23 to 0.06 MiB.
- Minified renderer stack traces need the devtools source view; no sourcemaps
  are emitted, which matches the previous release behavior.
- The brand marks now exist in two places.
- Stripping legacy font formats is safe only because the app runs exclusively in
  the bundled Chromium.
