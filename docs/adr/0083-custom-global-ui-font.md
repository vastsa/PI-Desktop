# ADR 0083: Custom global UI font

- Status: Superseded in part by ADR 0298
- Date: 2026-08-14
- Baseline: `0.4.16`
- Protocol: v9 (one additive Electron-main IPC channel; host RPC unchanged)
- Storage schema: v10 (optional `AppSettings.fontFamily` JSON field)

## Context

The shell typography is a single hardcoded token stack (`--font-sans`). Users
want to choose a global UI font from Settings — including open-licensed fonts
that are safe for commercial use — similar to the font picker in the dbx
desktop client, which enumerates system fonts and bundles an OFL family.

The renderer is sandboxed behind the preload IPC allowlist, and the app ships
a bundled renderer, so the font source must be local (no CDN/CSS font
services, per [07-ui-design-system §2](../spec/04-ux/07-ui-design-system.md)).

## Decision

### 1. Settings picker and persistence

Settings → Basics → Appearance gains a **Font** row with a searchable picker.
Selections persist as `AppSettings.fontFamily`, a CSS `font-family` stack
string. An absent or empty value means the built-in token stack; the picker
always offers **System default** first. Selecting System default persists an
empty stack (`fontFamily: ""`) rather than removing the key: `settings.set`
merges supplied fields into stored settings and JSON serialization drops
`undefined`, so an omitted key cannot clear a stored override.

The picker menu portals to `document.body` as a fixed body-level floating
layer (measured against the trigger and clamped to the viewport), so the
settings card's `overflow` cannot clip or squeeze it; it follows the body-level
floating-layer contract in the component spec.

### 2. Bundled open-licensed families (superseded by ADR 0298)

*(Historical. [ADR 0298](0298-remove-bundled-fonts.md) removed every bundled
family, so the picker offers System default plus installed system families and
nothing is loaded from disk.)*

Four families shipped with the app as `woff2`, all under the SIL Open Font
License 1.1 (free for commercial use and redistribution; license texts were
shipped under `apps/desktop/src/assets/fonts/licenses/`):

| Family | Script coverage | Source |
|---|---|---|
| Geist | Latin (variable) | vercel/geist-font |
| Inter | Latin (variable) | rsms/inter |
| Noto Sans SC | CJK (variable) | google/fonts (Source Han Sans lineage) |
| LXGW WenKai | CJK kai (regular) | lxgw/LxgwWenKai |

Every stack appends a CJK fallback tier so Chinese text stays readable when the
selected family has no CJK glyphs. The tier was (`Noto Sans SC`, `PingFang SC`,
`Hiragino Sans GB`, `Microsoft YaHei`, `sans-serif`) and is now the system-only
(`PingFang SC`, `Hiragino Sans GB`, `Microsoft YaHei`, `sans-serif`) after ADR
0298. The mono stack (`--font-mono`) is unchanged.

### 3. System font enumeration in Electron main

Electron main resolves installed system font families using platform tooling
only (no native modules), so the main bundle stays self-contained:

- macOS: `osascript` JXA bridging
  `CTFontManagerCopyAvailableFontFamilyNames` — the same CoreText query
  `font_kit::all_families()` uses, returning canonical CSS family names in
  tens of milliseconds — with `system_profiler SPFontsDataType -json` kept as
  a fallback when osascript is unavailable
- Windows: PowerShell `[Windows.Media.Fonts]::SystemFontFamilies`
- Linux: `fc-list -f "%{family[0]}\n"`

Results are deduplicated, filtered (hidden `.`-prefixed families excluded),
sorted, and cached for 60 seconds per process. The renderer reaches them
through one new allowlisted IPC channel, `pi-desktop/app/systemFonts`.

### 4. Application

The renderer overrides `--font-sans` on `document.documentElement` from
`AppSettings.fontFamily`; `body` and every `var(--font-sans)` consumer pick it
up without a reload. *(Superseded by [ADR 0298](0298-remove-bundled-fonts.md):
the `@font-face` rules, `apps/desktop/src/styles/fonts.css`, and its
`@import` in `globals.css` are deleted, so a stored stack resolves through
installed families.)*

## Consequences

- Users pick a global UI font once; it persists across restarts and renders
  offline from installed families ([ADR 0298](0298-remove-bundled-fonts.md) ships
  no font files).
- CJK coverage stays correct for every option via the appended fallback tier.
- macOS enumeration resolves through the fast CoreText path in tens of
  milliseconds (the previous `system_profiler` path took 2–5 s and is now only
  a fallback); the result is cached 60 s per process and returns canonical
  family names such as `PingFang SC` rather than system_profiler's localized
  aliases such as `苹方-简`.
- The installer carried roughly 16 MB of bundled font files; ADR 0298 removed
  them, so `out/renderer` emits no application font face and only KaTeX's
  `woff2` glyphs remain (see `06-delivery/06-release-runbook.md`).
- `@font-face` `font-weight` descriptors are exempted from the style-token
  guard because they describe font files, not UI typography.

## Alternatives

- **`font_kit` in host-core** (dbx's approach): fast native enumeration, but
  adds a host RPC method and widens the host protocol surface for a
  renderer-only preference; Electron main reaches the same CoreText family
  list through an `osascript` JXA bridge without widening the protocol.
- **`font-list` npm package**: clean API, but its internal directory
  `require("./libs/core")` does not survive electron-vite main bundling, and
  its macOS helper is a prebuilt binary that would need asar unpacking.
- **`queryLocalFonts()` (Local Font Access API)**: permission-gated in the
  sandboxed renderer and still experimental in Electron.
