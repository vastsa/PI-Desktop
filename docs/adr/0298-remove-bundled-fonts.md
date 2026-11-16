# ADR 0298: The app ships no fonts

- Status: Accepted
- Date: 2026-09-20
- Amends: [ADR 0083](0083-custom-global-ui-font.md) — its §2 bundled families,
  its `@font-face`/offline-rendering clauses, and its installer-size
  consequence — and D232
- Related: D598, E2E-126, E2E-092,
  [04-ux/07-ui-design-system.md](../spec/04-ux/07-ui-design-system.md)

## Context

ADR 0083 shipped the font picker with four bundled `woff2` families and a
`@font-face` layer, which became the bulk of the renderer's weight and carried
OFL notice obligations, while every target platform already resolves the same
coverage from its own fonts. The product wants the picker, not the payload.

## Decision

Nothing is bundled: the font assets, their license texts, `fonts.css` and its
import, `BUNDLED_FONTS`, the `license` field, the license badge, and the
`settings.fontBundled` key are deleted. `buildFontOptions` returns **System
default**, persisted as the empty string and treated as the built-in
`--font-sans` stack, followed by installed families enumerated exactly as
ADR 0083 §3 describes through `pi-desktop/app/systemFonts`, and a stored stack
matching no option is re-added first under **Saved**. Every generated stack
appends the system-only CJK tier, and stored `AppSettings.fontFamily` values are
preserved byte for byte rather than migrated, so no storage migration runs and
`settings.set`, the protocol version, and the schema version are untouched.

## Consequences

- `out/renderer` emits no application font face, leaving KaTeX's glyphs as the
  only `woff2` files, and the installer drops the four faces.
- A face the app used to supply now comes from the OS, so LXGW WenKai is no
  longer available out of the box, while Chinese text still renders through the
  fallback tier.
- The picker shows "System default plus whatever this machine has", the license
  badge and **Bundled** group disappear, and the OFL notice obligations leave
  the bundle.

## Alternatives

- Subset the bundled families: rejected, subsetting drops glyphs from
  user-supplied content and keeps the license tree and build wiring.
- Migrate stored bundled stacks to a system equivalent: rejected, there is no
  honest mapping and it would change rendering without user action.
