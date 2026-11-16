# ADR 0181: Main-owned picker capabilities

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: ADR 0059, ADR 0172, D197, D334, D344,
  `03-runtime/01-ipc-protocol.md` §13c, E2E-102h

## Context

Composer attachments can be selected through a native Electron file picker and
then copied into the owning session's scratch directory. The renderer needs to
request the copy after it materializes a home draft, but a renderer IPC payload
must not be treated as proof that a user selected the paths it contains.

## Decision

1. `composer/pickFiles` and `composer/pickPhotos` execute the native dialog in
   Electron main.
2. The picker token expires after 60 seconds and is consumed before the import
   starts.
3. `pickFiles` offers regular files only in the MVP.
4. Main still realpaths and stats every recorded source, enforces the existing
   per-file and total-size limits, and copies only into the session scratch
   directory.

## Consequences

- A compromised or stale renderer cannot turn the picker import channel into an
  arbitrary absolute-path copy primitive.
- Canceling a picker does not create a draft session or write scratch files.
- The renderer retains only the returned session-owned scratch references after
  import, while the source paths remain in Electron main.
- Directory selection is no longer offered with a misleading unsupported label.

## Alternatives rejected

- Returning native paths from the picker and validating them again in the import
  IPC: rejected because validation does not prove user selection.
- Importing directly before returning from the picker IPC: rejected because the
  renderer must materialize a home draft only after a non-canceled selection.
- Supporting folders by recursive copy in this change: rejected because it needs
  explicit traversal, size, symlink, and UI semantics beyond the current MVP.
