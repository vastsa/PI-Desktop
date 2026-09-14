# ADR 0248 — Package theme assets and contributed window backgrounds

- **Status**: Accepted for implementation
- **Date**: 2026-09-14
- **Related**: issue #334, issue #335, `07-plugins/04-plugin-security.md` §3.1, `07-plugins/02-plugin-manifest-schema.md` §4, `07-plugins/13-plugin-permissions-matrix.md`

## Context

A contributed theme (`ui.theme`) could only affect the renderer's CSS, and only
within two walls that made real theming impossible:

1. **References were `data:`-only.** `sanitizeThemeCss` refuses every `url()`
   target that is not a `data:` URI, and the sheet itself is capped at 256 KB.
   Base64 inflates by about a third, so a photographic background is not
   expressible at all: the usable original is under ~190 KB.
2. **The native window background ignored plugin themes.** The window is created
   with the host palette for the resolved light/dark base, so a plugin theme
   with a dark #0d1424 plate flashed — and kept — the host's `#181818`, while the
   renderer painted the theme's own colours inside it.

Both walls were deliberate. The first existed because a relative or remote
`url()` in plugin-authored CSS is a path the renderer would resolve on its own,
with no host in the loop to check it. The second existed because only built-in
theme ids had a background colour to apply.

## Decision

Two opt-in additions, both inert when absent.

### 1. `contributes.themes[].assets` and the `plugin-asset:` scheme

A theme may declare `assets: string[]` — package-relative paths whose extension
is on a whitelist (`png`, `jpg`, `jpeg`, `webp`, `avif`, `svg`, `woff2`) and
whose summed size is at most 4 MB. The declaration **does not** widen the sheet:
validation still refuses the raw text of any reference, and instead rewrites
each `url()` that matches a declared asset to
`plugin-asset://<pluginId>/<normalizedPath>`. Everything else keeps the existing
`data:`-only rule.

The scheme is host-owned:

- Reserved as privileged (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`,
  `stream`) before the app is ready.
- Handled by a main-process resolver that answers only from the runtime's
  per-plugin asset map — populated at theme registration from files that exist
  inside the plugin package, are not under `node_modules`, and fit the budget. A
  path nobody declared has no URL to begin with, and unloading a plugin clears
  its whole map.
- Served with an explicit MIME type, `nosniff`, and `no-store`.
- Admitted by the renderer CSP for `img-src` and `font-src`, and by the plugin
  panel egress policy as a local scheme (it is read-only and package-scoped, so
  it does not widen panel egress).

Permission: unchanged. Reading a file the plugin already ships, through a host
scheme that resolves only to that plugin's declared list, is the same capability
`ui.theme` already grants.

### 2. `contributes.windowAppearance.backgroundColor.{light,dark}`

A theme may name the native window background as `#rrggbb` or `#rrggbbaa`, one
slot per resolved palette. It is applied only while one of that plugin's themes
is the selected theme, and only for the palette the renderer has resolved —
`system` resolves to light or dark first, exactly as `data-theme` does.

Restoration is **derived, not remembered**. The renderer recomputes the colour
from the persisted preference and the live theme catalog on every theme, plugin,
and OS-appearance change and sends the result (or nothing). A switch to another
theme, a plugin disable, and a plugin uninstall all converge on the host palette
because the plugin theme is simply gone from the catalog. There is no stored
value to leak, and no exit path that can leave a half-applied colour behind —
including a crashed renderer, which leaves the host default with no theme
applied at all.

macOS keeps its `vibrancy` plate and never receives a colour, matching the
existing rule that darwin does not download one.

Permission: new `ui.window.appearance`, confirmed at install and shown in the
Settings permission list. A declaration without the grant is audited and
ignored.

Built-in themes reach the same value through a shared table
(`packages/shared/src/theme.ts`): `BUILTIN_THEMES` carries each palette's
`windowBackground` once, and `isThemeColorScheme` carries the "is this a
palette rather than `system`/a plugin theme" question once. The renderer, main,
the plugin panel host, the panel preload, and the theme picker all read it
instead of restating the `#ffffff` / `#181818` pair or re-listing the built-in
ids. The two paths therefore differ only in where the colour is declared, not in
how it is applied or restored. `system` stays resolved locally, because the
renderer asks `matchMedia` and main asks `nativeTheme`.

## Consequences

- A theme can ship a photographic background or a webfont and can own the native
  plate behind its own palette, without loosening the sheet's own rules.
- The renderer only ever sees a host scheme or a `data:` URI; a relative path
  still cannot reach the sheet.
- `contributes.windowAppearance` without `ui.window.appearance` is a manifest
  error in the SDK validator and in host-core, so the mismatch surfaces at
  install rather than at load.
- The window is created before any theme is known, so the very first frame of a
  cold start still uses the host palette. It is replaced as soon as the renderer
  runs its theme effect, which is the same moment the base palette is applied
  today.
- The asset handler reads each file synchronously. Within a 4 MB per-plugin
  budget this is bounded and avoids holding a stream open across a plugin
  unload, which is the failure mode that would matter more.
- The built-in window palette has one definition. It previously lived in four
  files, so a palette change could leave one of them behind and split the
  built-in and contributed paths — the exact divergence this ADR exists to
  prevent.

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
