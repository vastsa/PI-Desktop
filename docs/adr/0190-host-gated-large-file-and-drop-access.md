# ADR 0190: Host-gated large-file and dropped-file access

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** PI-Desktop maintainers

## Context

The log-viewer plugin needs byte-range reads and file metadata to page and
follow very large logs. Its previous implementation used `node:fs` in the
plugin process for those operations and used a renderer worker to read dropped
`File` snapshots. That split the engine and left the file-range path outside
the host permission gateway.

## Decision

Add host-owned `fs.stat` and bounded `fs.readRange` APIs under the existing
`fs.read` root, scope, symlink, protected-path, deny-list, consent, and audit
checks. A range call is capped at 8 MiB and returns `{ bytes, totalSize }`.

Expose `webUtils.getPathForFile` through the panel preload as
`pluginBridge.getDroppedFilePath`. The panel host records paths from a real
drop gesture for a short time and lets `fs.registerDropped` consume one path
once. The runtime issues a memory-only grant for exactly that canonical regular
file. The grant is read-only, cannot be used with another path, is rechecked on
every access, and dies with the plugin process.

The log viewer uses the host APIs for both picked and dropped files. It has no
raw `node:fs` fallback and does not provide export or write functionality.

## Consequences

- Large-file indexing, pagination, search, follow, and rotation share one
  permission-gated engine.
- Dropped files can follow appends during the current plugin session.
- Dropped-file grants do not become manifest scope and are not persisted.
- Older hosts without the new APIs cannot load this plugin version; it fails
  closed instead of silently bypassing the gateway.
- The real drag-and-drop flow still requires desktop gesture testing; unit and
  integration tests cover the grant, path, and byte-range boundaries.

## Alternatives considered

- Keep raw `node:fs` in the plugin: rejected because it bypasses host policy.
- Keep renderer `Blob.slice` worker reads: rejected because it duplicates the
  engine and cannot observe file growth or preserve a host file identity.
- Add a broad user-selected root for dropped files: rejected because a single
  dropped file should not authorize its containing directory.
