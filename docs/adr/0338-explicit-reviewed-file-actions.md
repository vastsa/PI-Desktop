# ADR 0338: Explicit actions on reviewed files

- Status: Accepted
- Date: 2026-10-30
- Related: [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md)

## Context

Review records approved Write/Edit operations outside the workspace, but the
normal file-open APIs deliberately accept only project and host-owned roots.
Widening those APIs would change unrelated filesystem authorization. Separately,
rendering one footer per operation makes a file with several edits look like
several independently actionable files.

## Decision

External open and folder reveal for a non-workspace review row use a dedicated
main-window-only IPC request containing session ID, snapshot ID and destination.
No renderer-supplied path is accepted. The Rust Host verifies that the snapshot
belongs to a successful persisted tool message in that session and resolves its
exact recorded file. Host and Main reject missing files, directories, sensitive
paths and replacement symlinks. Main then invokes the system default application
or reveals the file in the system file manager. This explicit user action grants
neither directory access nor read/write capability to a tool or plugin. Generic
`fsOpen`, `fsReveal`, permission evaluation and remote-session behavior are unchanged.
Non-workspace file menus do not offer internal open.

The Review panel renders recorded hunks continuously with one copy/rollback
footer per file. Copy includes all recorded operations in order and does not
claim a net diff. File rollback selects the anchor snapshot's owning round and
file on the Host; the renderer cannot omit intermediate operations. Before one
file restoration, Host validates the entire active hash chain, captured root,
restoration bytes and current hash. Conflicts leave the file and record states
untouched. Success updates each participating snapshot and transcript state.
Existing single-snapshot rollback and inline chat actions remain unchanged.

File-action menu density is opt-in. Review scope and historical round selection
reuse the shared native Select with review-only customizable-picker styles.
Selected fills follow the sidebar color, and only the list's outer top/bottom
option corners are rounded. The scope trigger is 24px high and the round field
28px; both vertically center their text and arrow. Shared primitives, Command
shell and other selectors keep their defaults.

## Consequences

- Recorded external files can be opened without relaxing the general path sandbox.
- One file has one action bar, while individual immutable snapshots remain intact.
- Discontinuous or conflicted chains cannot be partially rolled back.
- External snapshots remain non-reversible; explicit opening is not write permission.
- Scope/history retain native selection behavior without changing shared defaults.

## Alternatives rejected

- Add snapshot roots to general filesystem roots: grants more than the clicked file.
- Accept a raw external path from Renderer: loses binding to native recorded evidence.
- Repeatedly call single-snapshot rollback: can stop halfway through a file's edits.
- Merge cached hunks into a purported net diff: bounded historical hunks do not contain
  arbitrary complete after-images, so they cannot establish that claim.
