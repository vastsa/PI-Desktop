# ADR 0341: Explicit actions on reviewed files

- Status: Accepted
- Date: 2026-10-30
- Related: [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md)

## Context

Review records approved Write/Edit operations outside the workspace, but the
normal file-open APIs deliberately accept only project and host-owned roots.
Widening those APIs would change unrelated filesystem authorization.

## Decision

External open and folder reveal for a non-workspace review row use a dedicated
main-window-only IPC request containing session ID, snapshot ID and destination.
No renderer-supplied path is accepted.

The Review panel renders recorded hunks continuously with one copy/rollback
footer per file. Copy includes all recorded operations in order and does not
claim a net diff.

## Consequences

- Recorded external files can be opened without relaxing the general path
  sandbox.
- One file has one action bar, while individual immutable snapshots remain
  intact.
- Discontinuous or conflicted chains cannot be partially rolled back.
- External snapshots remain non-reversible; explicit opening is not write
  permission.
- Scope/history retain native selection behavior without changing shared
  defaults.

## Alternatives rejected

- Add snapshot roots to general filesystem roots: grants more than the clicked
  file.
- Accept a raw external path from Renderer: loses binding to native recorded
  evidence.
- Repeatedly call single-snapshot rollback: can stop halfway through a file's
  edits.
- Merge cached hunks into a purported net diff: bounded historical hunks do not
  contain arbitrary complete after-images, so they cannot establish that claim.
