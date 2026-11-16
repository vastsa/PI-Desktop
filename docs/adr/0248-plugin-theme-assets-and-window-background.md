# ADR 0248 — Package theme assets and contributed window backgrounds

- **Status**: Accepted for implementation
- **Date**: 2026-09-14
- **Related**: issue #334, issue #335, `07-plugins/04-plugin-security.md` §3.1, `07-plugins/02-plugin-manifest-schema.md` §4, `07-plugins/13-plugin-permissions-matrix.md`

## Context

A contributed theme (`ui.theme`) could only affect the renderer's CSS, and only
within two walls that made real theming impossible:

1. **References were `data:`-only.** `sanitizeThemeCss` refuses every `url()`
   target that is not a `data:` URI, and the sheet itself is capped at 256 KB.
2. **The native window background ignored plugin themes.** The window is created
   with the host palette for the resolved light/dark base, so a plugin theme
   with a dark #0d1424 plate flashed — and kept — the host's `#181818`, while
   the renderer painted the theme's own colours inside it.

## Decision

Two opt-in additions, both inert when absent.

### 1. `contributes.themes[].assets` and the `plugin-asset:` scheme

A theme may declare `assets: string[]` — package-relative paths whose extension
is on a whitelist (`png`, `jpg`, `jpeg`, `webp`, `avif`, `svg`, `woff2`) and
whose summed size is at most 4 MB. The declaration **does not** widen the sheet:
validation still refuses the raw text of any reference, and instead rewrites
each `url()` that matches a declared asset to
`plugin-asset://<pluginId>/<normalizedPath>`.

The scheme is host-owned:

- Reserved as privileged (`standard`, `secure`, `supportFetchAPI`,
  `corsEnabled`, `stream`) before the app is ready.
- Handled by a main-process resolver that answers only from the runtime's
  per-plugin asset map — populated at theme registration from files that exist
  inside the plugin package, are not under `node_modules`, and fit the budget.
- Served with an explicit MIME type, `nosniff`, and `no-store`.
- Admitted by the renderer CSP for `img-src` and `font-src`, and by the plugin
  panel egress policy as a local scheme (it is read-only and package-scoped, so
  it does not widen panel egress).

### 2. `contributes.windowAppearance.backgroundColor.{light,dark}`

A theme may name the native window background as `#rrggbb` or `#rrggbbaa`, one
slot per resolved palette. It is applied only while one of that plugin's themes
is the selected theme, and only for the palette the renderer has resolved —
`system` resolves to light or dark first, exactly as `data-theme` does.

Restoration is **derived, not remembered**. The renderer recomputes the colour
from the persisted preference and the live theme catalog on every theme, plugin,
and OS-appearance change and sends the result (or nothing).

> **Amended by ADR 0332.** macOS keeps its translucent vibrancy surface by
> default, so `windowAppearance.backgroundColor` is skipped there exactly as
> described above; turning off `settings.macosWindowTranslucency` paints the
> opaque native surface and applies the colour like every other platform. The
> permission, the derived-not-remembered restoration, and the palette resolution
> above are unchanged.

## Consequences

- A theme can ship a photographic background or a webfont and can own the native
  plate behind its own palette, without loosening the sheet's own rules.
- The renderer only ever sees a host scheme or a `data:` URI; a relative path
  still cannot reach the sheet.
- `contributes.windowAppearance` without `ui.window.appearance` is a manifest
  error in the SDK validator and in host-core, so the mismatch surfaces at
  install rather than at load.
- The window is created before any theme is known, so the very first frame of a
  cold start still uses the host palette.
- The asset handler reads each file synchronously.

## Alternatives

- **Raise the `data:` size cap.** Keeps one channel, but a 4 MB sheet in a
  `<style>` element costs base64 inflation, a parse on every plugin change, and
  memory in the renderer, and it still cannot express a large image well.
- **Allow relative `url()` and let the renderer resolve it.** Hands path
  resolution back to plugin-authored content; that is precisely what the
  `data:`-only rule exists to prevent.
- **Serve assets over `file://`.** No allowlist, no MIME control, and every
  plugin would reach the whole filesystem the app can read.
- **Remember and restore the native background on the main side.** Requires
  persisting a derived value and re-deriving it on every exit path; deriving it
  from live state on each change has no state to restore.
