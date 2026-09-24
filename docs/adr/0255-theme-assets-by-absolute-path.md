# ADR 0255: Theme assets are absolute paths

- Status: Accepted
- Date: 2026-09-15
- Decision: D422
- Supersedes: ADR 0248 §1 for asset path resolution; the scheme, the `url()`
  rewrite, the extension whitelist, the size budget, and the unload revocation
  carry over unchanged.

## Context

ADR 0248 let a theme reference plugin package bytes: `contributes.themes[].assets`
listed package-relative paths, the host resolved them inside the plugin package,
and each matching `url()` was rewritten to `plugin-asset://`.

That boundary has two costs in practice:

- A plugin that wants a user-chosen image has to copy it into its own package.
  A development plugin is watched recursively (`plugin-watcher.ts`), so every
  such write reloads the plugin, and a reload closes that plugin's panel window
  (`plugin-runtime.ts` unload path → `closePanel`).
- The plugin's own data directory — `pi.plugin.getDataPath()`, the one writable
  area a plugin owns outside its package — cannot be referenced at all.

Plugins already run as ordinary Node processes with full filesystem access. The
package scope constrained what theme *CSS text* could reach, not what the plugin
itself could read.

## Decision

1. A theme asset is an **absolute path**: `C:/art/bg.png`, `/art/bg.png`, or
   either spelled as a `file:` URL. Package-relative references are no longer
   assets; `normalizeThemeAssetPath` (SDK) and `normalize_theme_asset_path`
   (host-core) reject them.
2. Both authorization routes accept absolute paths:
   - `contributes.themes[].assets` — load-time, auditable in the manifest;
   - `pi.themes.upsert({ id, label, base, css })` — the runtime route now
     resolves asset references in the sheet and registers them in that plugin's
     asset map for as long as the plugin stays loaded. The upsert is a message,
     not a file write, so a theme can pick up a new image without a reload.
3. Everything else about the mechanism is unchanged: the extension whitelist
   (`png`, `jpg`, `jpeg`, `webp`, `avif`, `svg`, `woff2`), the summed 4 MB budget
   for declared assets, `.`/`..` rejection, the `url()` → `plugin-asset://`
   rewrite, `nosniff`, `no-store`, and revocation when the plugin unloads.
4. Absolute keys are percent-encoded in the `plugin-asset://` URL
   (`themeAssetUrl`) and decoded by the handler, so spaces, `?`, `#`, and the
   drive colon cannot be re-read as anything but a path.
5. The handler serves what the plugin registered: a path from its manifest, or a
   path its own sanitized sheet referenced through an upsert.

## Consequences

- A plugin can hand the renderer **any local file it can read**, as an image or
  a font. The host no longer enforces "theme assets live in the plugin package",
  so a theme — which is data, and may arrive inside a shared theme pack — can
  name a file the user never chose. Manifest-declared assets keep an audit trail
  in a static, reviewable file; runtime-registered ones have none and vanish
  with the plugin.
- The extension whitelist still bounds what may be served, the size budget still
  bounds declared assets, and an unregistered reference is still refused.
- Because a theme may point at the plugin's data directory, a development plugin
  no longer reloads when the user picks or replaces an image: the upload writes
  into `getDataPath()/images/`, and the theme reaches it through an upsert.
- Themes that declared package-relative assets stop resolving. This is a
  deliberate breaking change; the affected surface is limited to themes that use
  `assets` at all.
- The plugin devkit (`pi-plugin check`) rejects package-relative theme assets at
  author time with the `theme.asset-package-relative` diagnostic, preventing a
  package from passing validation only to fail installation on every user's
  machine.
- `resolveInsidePlugin` remains for the theme sheet path itself
  (`contributes.themes[].path`), which is still package-relative.

## Alternatives considered

- **Allow both spellings.** Rejected: the owner chose an absolute-only rule, and
  keeping two resolutions for one concept invites exactly the confusion this
  change removes.
- **Add only the plugin data directory as a second root.** Narrower, but it does
  not cover a file the user picked outside the data directory without a copy
  step, and the runtime route would still have no way to authorize it.
