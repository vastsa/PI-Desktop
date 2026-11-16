# ADR 0125: Renderer Ships Derived Brand Marks and Minified Output

- Status: Accepted
- Date: 2026-08-26
- Related: ADR 0083, D079, D094

## Context

Three costs in a 31 MiB renderer output were accidental rather than product
decisions: `electron-vite` defaults its renderer preset to `minify: false` and
the config did not override it, KaTeX declared `woff` and `truetype` sources that
the bundled Chromium never needs, and `BrandLogo` imported the 1024x1024 PNG
master to draw a 64 px mark. The Electron shell itself accounts for almost all
of the unpacked application size, so the renderer was the only part worth
tuning.

## Decision

The renderer build sets `minify: "esbuild"` explicitly, asserted by the
packaging footprint test because the framework default would silently undo it. A
`pi-drop-legacy-font-fallbacks` Vite plugin strips comma-prefixed `woff` and
`truetype` fallback `src` entries at `enforce: "pre"` before Vite registers
`url()` values as assets, keeping a face whose only source is one of those
formats. `build/icon_1024.png` and `build/logo_dark.png` remain the canonical
brand masters; this amends D079 and D094 so the renderer imports derived 192x192
marks from `apps/desktop/src/assets/brand/`, regenerated with `sips -Z 192`
whenever the masters change, with no change to visual identity.

Font subsetting is no longer part of this decision.
[ADR 0298](0298-remove-bundled-fonts.md) removed the bundled CJK faces instead,
since subsetting would have dropped glyphs from user-supplied content.

## Consequences

- The renderer output drops by roughly seven MiB of JavaScript, font, and PNG
  weight, measured before [ADR 0298](0298-remove-bundled-fonts.md).
- Minified stack traces need the devtools source view; no sourcemaps are
  emitted, matching previous release behavior.
- Brand marks now exist in two places, and the packaging footprint test fails if
  the renderer imports from `build/` again.

## Alternatives

- Subset the bundled CJK faces: it would have dropped glyphs from
  user-supplied content, so ADR 0083 had to be revised instead.
