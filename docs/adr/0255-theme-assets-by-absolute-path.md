# ADR 0255: Theme assets are absolute paths

- Status: Accepted (supersedes ADR 0248 §1 for asset path resolution)
- Date: 2026-09-15
- Related: D422, ADR 0248

## Context

ADR 0248 let a theme reference plugin package bytes: `contributes.themes[].assets`
listed package-relative paths and each matching `url()` was rewritten to
`plugin-asset://`. A plugin wanting a user-chosen image therefore had to copy it into
its own package, where the recursive development watcher reloaded the plugin and closed
its panel window, and the plugin's own data directory — `pi.plugin.getDataPath()` — could
not be referenced at all. Plugins already run as ordinary Node processes with full
filesystem access, so package scope constrained what theme CSS text reached, not what a
plugin could read.

## Decision

A theme asset is an absolute path (`C:/art/bg.png`, `/art/bg.png`, or either as a
`file:` URL), and `normalizeThemeAssetPath` in the SDK and `normalize_theme_asset_path`
in host-core reject package-relative references. Both authorization routes accept them:
`contributes.themes[].assets` at load time, auditable in the manifest, and
`pi.themes.upsert({ id, label, base, css })`, where the runtime resolves asset
references in the sheet and registers them in that plugin's asset map while it stays
loaded, so a theme picks up a new image without a reload. The rest of the mechanism is
unchanged: the `png`, `jpg`, `jpeg`, `webp`, `avif`, `svg`, `woff2` whitelist, the summed
4 MB budget, `.`/`..` rejection, the `url()` rewrite, `nosniff`, `no-store`, and
revocation on unload. Absolute keys are percent-encoded by `themeAssetUrl` and decoded by
the handler, which serves only what the plugin registered — a manifest path or one its
own sanitized sheet referenced through an upsert.

## Consequences

- A plugin can hand the renderer any local file it can read as image or font, so a theme
  can name a file the user never chose; manifest assets keep a static audit trail,
  runtime-registered ones have none and vanish with the plugin.
- The whitelist, budget, and unregistered-reference refusal still bound what is served.
- Themes with package-relative assets stop resolving, a deliberate breaking change that
  `pi-plugin check` reports as `theme.asset-package-relative`; `resolveInsidePlugin`
  remains for `contributes.themes[].path`.

## Alternatives

- Allow both spellings: two resolutions for one concept invite the same confusion.
- Add only the plugin data directory as a second root: does not cover a file picked
  outside it without a copy step.
