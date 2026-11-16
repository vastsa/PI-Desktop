# ADR 0248 — Package theme assets and contributed window backgrounds

- Status: Accepted for implementation
- Date: 2026-09-14
- Related: issue #334, issue #335, ADR 0332

## Context

A contributed theme (`ui.theme`) could only touch renderer CSS inside two walls:
`sanitizeThemeCss` refused every non-`data:` `url()` under a small sheet cap, so a
photographic background was inexpressible, and the native window background used the
host palette, so a plugin theme with a dark plate flashed and kept the host colour.

## Decision

Two opt-in additions, inert when absent.

### 1. `contributes.themes[].assets` and the `plugin-asset:` scheme

A theme may declare `assets: string[]` of package-relative paths with a whitelisted
extension and a bounded summed size, which does not widen the sheet: validation still
rewrites each `url()` matching a declared asset to
`plugin-asset://<pluginId>/<normalizedPath>`, keeps the `data:`-only rule for everything
else, and the scheme is reserved as privileged before app readiness, served by a
main-process resolver from the runtime's per-plugin asset map only, and admitted by the
renderer CSP for `img-src`/`font-src` and by the plugin panel egress policy, while
`ui.theme` already grants reading files the plugin ships.

### 2. `contributes.windowAppearance.backgroundColor.{light,dark}`

A theme may name the native window background as `#rrggbb` or `#rrggbbaa`, one slot per
resolved palette, applied only while one of that plugin's themes is selected, with
restoration derived rather than remembered so switching, disabling, or uninstalling
converges on the host palette and no exit path leaves a half-applied colour; the new
`ui.window.appearance` permission gates it, a declaration without the grant is audited
and ignored, macOS keeps its `vibrancy` plate unless `settings.macosWindowTranslucency`
is off (ADR 0332), and built-in themes reach the same table through `BUILTIN_THEMES` and
`isThemeColorScheme` in `packages/shared/src/theme.ts`.

## Consequences

- A theme can ship a photographic background or webfont and own the native plate behind
  its own palette, while the renderer only ever sees a host scheme or a `data:` URI.
- `contributes.windowAppearance` without `ui.window.appearance` is a manifest error in
  the SDK validator and host-core, surfacing at install.
- The window exists before any theme is known, so the first cold-start frame uses the
  host palette.

## Alternatives

- Raise the `data:` size cap: base64 inflation, a parse per plugin change, and renderer
  memory.
- Serve assets over `file://`: no allowlist, no MIME control, and every plugin reaches
  the whole filesystem.
