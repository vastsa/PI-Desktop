# ADR 0043: Message-owned review snapshots and guarded rollback

- Status: Accepted
- Date: 2026-08-02
- Amended: 2026-10-22
- Related: [03-tools-and-permissions](../spec/03-runtime/03-tools-and-permissions.md) ·
  [04-data-storage](../spec/03-runtime/04-data-storage.md) ·
  [06-host-rpc-protocol](../spec/03-runtime/06-host-rpc-protocol.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [E2E-057](../spec/06-delivery/04-e2e-test-plan.md)
- Supersedes: ADR 0042's Git-dependent review source, D098, and D179
- Amended by: [ADR 0087](0087-line-anchored-edit-contract.md) (`Edit` may now
  record a move as two entries, and a rollback invalidates session edit
  snapshots for the path)

## Context

The previous Review implementation reconstructed each card from the current
Git working tree. A commit therefore removed the evidence for an earlier tool
message, and a later edit to the same path could make an old message appear to
describe work it never performed. The same model had no safe way to restore a
specific message's previous file content.

Review is a conversation feature, so its evidence must belong to the message
that produced it rather than to a mutable repository snapshot.

## Decision

1. After normal path authorization, before any `Write` or `Edit`, host-core
   captures the previous file bytes in a session-scoped snapshot outside the
   workspace. Successful workspace, scratch, visualization, and approved external
   mutations write bounded `details.review` evidence into the tool result. The
   record contains snapshot/message ids, a workspace-relative or otherwise
   absolute path, operation,
   added/modified/deleted status, addition/deletion counts, expandable hunks,
   active/rolled-back state, and whether rollback is reversible.
2. The renderer derives `ReviewChangeCard` and the Review panel's chronological
   history from persisted tool messages only. It never refreshes or matches a
   current Git diff. In the transcript a review-backed `Write`/`Edit` renders as
   one tool-level row: the file header and its diff body, with no second generic
   tool header above it. It remains visible after commit, workspace switching,
   and restart.
3. `review.rollback({sessionId, snapshotId})` is a host-owned operation. Before
   writing, host-core verifies that the current file hash equals the post-tool
   hash recorded in the snapshot. A mismatch returns `conflict` and leaves the
   file untouched. A match restores the previous bytes or removes a file that
   the message created, then persists `state: "rolledBack"` on the tool row.
4. Snapshot storage is bounded and session-owned:
   `<data_dir>/review-changes/<sessionId>/<snapshotId>/{before,meta.json}`.
   Session deletion removes it; startup removes directories for missing
   sessions. Forked transcripts retain visible diff evidence but mark rollback
   unavailable because the source snapshot belongs to another session.
5. Failed, denied, sensitive, or unresolvable operations do not create review
   records. Non-workspace snapshots are readable evidence, not persistent path
   grants, so they are non-reversible; existing file-open authorization remains
   unchanged. Large or binary files may omit hunks and rollback when the bounded
   previous content cannot be retained.

## Consequences

- Committing after a tool no longer makes its review number or card disappear.
- Every visible diff is tied to the exact message that produced it, including
  additions, deletions, and modifications.
- Rollback is explicit, idempotent, and refuses to overwrite later work.
- Review no longer promises to describe unrelated shell mutations; structured
  Write/Edit results are the durable review boundary.
- Snapshot bytes add host-owned local storage, bounded by file and diff caps.

## Alternatives rejected

- **Keep reading Git HEAD:** commits erase the evidence and cannot identify the
  message responsible for a later same-path edit.
- **Store only a renderer patch:** the renderer cannot safely restore files,
  and the patch would be lost on restart or session reload.
- **Rollback unconditionally:** it could overwrite a user's later edit or an
  external change, so the post-tool hash guard is mandatory.

## Round review reader amendment

The native Review panel additionally groups persisted changes by user conversation
round and execution root/path. Latest means the newest user round with recorded
changes, not the most recently arriving tool result. Delegate ancestry and the
Host message-turn index preserve ownership of late results. This is a read
projection, not a second capture store or a change to model context.

New snapshots retain bounded 1/3/5-line context hunks next to the existing
`before` rollback snapshot and optional execution-root metadata. `review.context`
reads these immutable hunks only; no full after-image cache is created. Legacy records retain their recorded hunks and explicitly
report unavailable expanded context. The root is provenance, not permission;
rollback cannot use it to write into a different checkout. Existing hash guards,
session cleanup and preview computation budgets remain in force.
