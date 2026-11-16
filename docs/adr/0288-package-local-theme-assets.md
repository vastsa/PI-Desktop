# ADR 0288: Package-local theme assets remain available

- Status: Accepted for implementation
- Date: 2026-09-17
- Decision: D445
- Amends: ADR 0255

## Context

ADR 0255 allowed external absolute paths for theme contributions, which cannot
identify an image inside an installed marketplace archive on another machine, while
host-rendered scenic Settings destinations need images that travel with the theme
package.

## Decision

1. A declared theme asset may be an extension-whitelisted absolute path, keeping
   ADR 0255's validation and percent-encoded URL keys, or a package-relative path.
2. The host resolves a package-relative path with `resolveInsidePlugin`, rejects
   traversal and `node_modules`, checks existence and the shared asset budget, then
   records the file under its package-relative key.
3. `plugin-asset:` remains the sole renderer access path: it serves only registry
   files with the extension MIME allowlist, no-store and nosniff, and is revoked on
   disable, unload, or crash.
4. Scenic card previews must name a declared asset of the same plugin and add no
   filesystem, network, or renderer-DOM authority.

## Consequences

Marketplace theme packs ship portable local art without arbitrary filesystem reads,
themes naming an absolute path keep working, and an undeclared CSS `url()` is
rejected before it reaches the renderer.
