# ADR 0341: Explicit actions on reviewed files

- Status: Accepted
- Date: 2026-10-30
- Related: [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md)

## Context

Review records approved Write/Edit operations outside the workspace, but the normal
file-open APIs deliberately accept only project and host-owned roots, and widening
them would change unrelated filesystem authorization. Rendering one footer per
operation also makes a file with several edits look like several independently
actionable files.

## Decision

External open and folder reveal for a non-workspace review row use a dedicated
main-window-only IPC request carrying session id, snapshot id, and destination, so
no renderer-supplied path is accepted. The Rust host verifies that the snapshot
belongs to a successful persisted tool message in that session and resolves its
exact recorded file, and host plus main reject missing files, directories, sensitive
paths, and replacement symlinks before main opens the system default application or
reveals the file. That action grants no directory access and no capability to a
tool or plugin, generic `fsOpen`, `fsReveal`, and permission evaluation are
unchanged, and non-workspace file menus offer no internal open.

The Review panel renders recorded hunks continuously with one copy/rollback footer
per file: copy includes every recorded operation in order without claiming a net
diff, and file rollback selects the anchor snapshot's owning round and file on the
host, so the renderer cannot omit intermediate operations. Before restoring a file
the host validates the active hash chain, captured root, restoration bytes, and
current hash, conflicts leave both states untouched, and success updates each
participating snapshot and transcript state.

## Consequences

- Recorded external files can be opened without relaxing the general path sandbox.
- One file has one action bar while individual immutable snapshots stay intact.
- A conflicted chain cannot be partially rolled back, and explicit opening is not
  write permission.

## Alternatives

- Add snapshot roots to general filesystem roots — rejected: it grants more than the
  clicked file.
- Accept a raw external path from the renderer — rejected: it loses the binding to
  native recorded evidence.
