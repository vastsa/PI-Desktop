# ADR 0190: Host-gated large-file and dropped-file access

- **Status:** Accepted
- **Date:** 2026-09-09

## Context

The log-viewer plugin needs byte-range reads and file metadata to page and follow
very large logs, but its earlier implementation used `node:fs` in the plugin
process and a renderer worker for dropped `File` snapshots. That split the
engine and left the file-range path outside the host permission gateway.

## Decision

Add host-owned `fs.stat` and bounded `fs.readRange` under the existing `fs.read`
root, scope, symlink, protected-path, deny-list, consent, and audit checks, with
each range call capped at 8 MiB and returning `{ bytes, totalSize }`.
`webUtils.getPathForFile` is exposed through the panel preload as
`pluginBridge.getDroppedFilePath`, the panel host records paths from a real drop
gesture for a short time, and `fs.registerDropped` consumes one path once into a
memory-only read-only grant that is rechecked on every access, cannot address
another path, and dies with the plugin process.

The log viewer uses the host APIs for picked and dropped files alike, with no raw
`node:fs` fallback and no export or write path.

## Consequences

- Indexing, pagination, search, follow, and rotation share one permission-gated
  engine, and dropped files can follow appends during the plugin session.
- Dropped-file grants never become manifest scope and are not persisted.
- Older hosts without these APIs fail closed instead of bypassing the gateway.

## Alternatives considered

- Keep raw `node:fs` in the plugin: it bypasses host policy.
- Add a user-selected root for dropped files: one dropped file should not
  authorize its containing directory.
