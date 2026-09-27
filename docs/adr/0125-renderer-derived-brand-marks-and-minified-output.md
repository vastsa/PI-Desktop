# ADR 0125: Renderer Ships Derived Brand Marks and Minified Output

- Status: Accepted
- Date: 2026-08-26
- Related: ADR 0083, D079, D094
- Baseline: `0.10.8`

## Context

The renderer output was 31 MiB, and three of its costs were accidental rather
than product decisions:

1. `electron-vite` hard-defaults its renderer preset to `minify: false`, unlike
   plain Vite. `apps/desktop/electron.vite.config.ts` did not override it, so
   every production build shipped unminified chunks; the entry chunk alone was
   108,273 lines.
2. KaTeX's stylesheet declares `woff2`, `woff`, and `truetype` sources for each
   of its faces. The bundled Chromium supports `woff2` universally, so 40
   `.woff`/`.ttf` files (0.78 MiB) were emitted and never served.
3. D079 and D094 named `build/icon_1024.png` as the canonical brand mark, and
   `BrandLogo` imported it directly. That file is the 1024x1024 master
   `scripts/make-icon.py` derives `build/icon.icns` from. `BrandLogo` renders at
   16, 20, and 64 CSS px, so the renderer carried 1.04 MiB of PNG to draw a
   64 px mark.

None of this is Electron's own footprint. The unpacked application is about
279 MB, but a bare Electron 43.4.0 shell with no application code is already
about 277 MB, so the renderer is the only part worth tuning.

## Decision

1. The renderer build sets `minify: "esbuild"` explicitly. The setting is
   asserted by `packaging-footprint.test.mjs` because the framework default
   would silently undo it.
2. A `pi-drop-legacy-font-fallbacks` Vite plugin removes `woff` and `truetype`
   `src` entries from CSS with `enforce: "pre"`, before Vite registers `url()`
   values as assets. Stripping them later leaves the assets emitted. Only
   comma-prefixed fallback entries are removed, so a face whose single source
   is `woff` or `truetype` keeps it.
3. `build/icon_1024.png` and `build/logo_dark.png` remain the canonical brand
   masters and the source of truth for installer icons. This amends D079 and
   D094 on one point: the renderer imports **derived** marks at
   `apps/desktop/src/assets/brand/logo-light.png` and `logo-dark.png` instead
   of the masters. The derived files are 192x192, covering a 64 px render at 3x
   device pixel ratio. Regenerate them from the masters with `sips -Z 192`
   whenever the canonical marks change; the visual identity is unchanged.

The two bundled CJK faces stay unsubset. ADR 0083 section 2 appends
`Noto Sans SC` to every font stack so Chinese text stays readable offline, and
subsetting would drop glyphs from user-supplied content. Reducing those 15 MiB
requires revising ADR 0083, not a build-config change.

## Consequences

- `out/renderer` drops from 31 MiB to 24 MiB: JavaScript 12.53 to 7.72 MiB,
  legacy font fallbacks 0.78 MiB to 0, PNG brand assets 1.23 to 0.06 MiB.
- Minified renderer stack traces need the devtools source view; no sourcemaps
  are emitted, which matches the previous release behavior.
- The brand marks now exist in two places. `packaging-footprint.test.mjs`
  asserts the renderer does not import from `build/`, so a future contributor
  reintroducing the master path fails the suite rather than silently regaining
  1 MiB.
- Stripping legacy font formats is safe only because the app runs exclusively
  in the bundled Chromium. Plugin panels sanitize their own theme CSS to
  `data:` URIs and cannot reference renderer font assets, and the docs site
  uses an independent theme.
