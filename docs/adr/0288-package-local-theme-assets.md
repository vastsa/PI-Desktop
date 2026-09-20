# ADR 0288: Package-local theme assets remain available

- Status: Accepted for implementation
- Date: 2026-09-17
- Decision: D445
- Amends: ADR 0255

## Context

ADR 0255 made external absolute paths available to theme contributions. That
supports a theme whose plugin owns a user-selected image outside its package,
but an absolute path cannot identify an image in an installed marketplace
archive on another machine.

Host-rendered scenic Settings destinations need preview images and background
images that travel with their theme package. Requiring an absolute path would
make a packaged theme either non-portable or dependent on a separate file
selection capability.

## Decision

1. A declared theme asset may be either an extension-whitelisted absolute path
   or an extension-whitelisted package-relative path.
2. The host resolves a package-relative path with `resolveInsidePlugin`, rejects
   traversal and `node_modules`, verifies existence and the shared asset budget,
   then records the resolved file under its package-relative key.
3. Absolute assets retain ADR 0255's existing validation, percent-encoded URL
   keys, and runtime registration behavior.
4. The `plugin-asset:` protocol remains the sole renderer access path. It only
   serves a file recorded by the loaded plugin's asset registry, uses the
   extension MIME allowlist, no-store, nosniff, and revokes the registry on
   disable, unload, or crash.
5. Scenic card previews must name one declared asset owned by the same plugin.
   They do not add filesystem, network, renderer-DOM, or image-upload authority.

## Consequences

- Marketplace theme packs can ship portable local art without exposing arbitrary
  filesystem reads.
- Existing themes that intentionally name an external absolute path keep
  working.
- Theme authors must declare every image and font; an undeclared CSS `url()` is
  rejected before it reaches the renderer.
