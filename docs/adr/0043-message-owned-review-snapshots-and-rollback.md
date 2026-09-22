# ADR 0043: Message-owned review snapshots and guarded rollback

- Status: Accepted
- Date: 2026-08-02
- Related: [03-tools-and-permissions](../spec/03-runtime/03-tools-and-permissions.md) ·
  [04-data-storage](../spec/03-runtime/04-data-storage.md) ·
  [06-host-rpc-protocol](../spec/03-runtime/06-host-rpc-protocol.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [E2E-057](../spec/06-delivery/04-e2e-test-plan.md)
- Supersedes: ADR 0042's Git-dependent review source, D098, and D179
- Amended by: [ADR 0087](0087-line-anchored-edit-contract.md) (`edit` may now
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

1. Before a workspace `write` or `edit`, host-core captures the previous file
   bytes in a session-scoped snapshot outside the workspace. After a successful
   tool, it writes a bounded `details.review` record into the tool result. The
   record contains the snapshot id, message/tool id, relative path, operation,
   added/modified/deleted status, addition/deletion counts, expandable hunks,
   active/rolled-back state, and whether rollback is reversible.
2. The renderer derives `InlineReviewCard` and the Review panel's chronological
   history from persisted tool messages only. It never refreshes or matches a
   current Git diff. A card stays immediately after its owning tool row and
   remains visible after commit, workspace switching, and restart.
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
5. Scratch-root writes, failed tools, and tools without a structured workspace
   path do not create review records. Large or binary files may still show
   status/count metadata while omitting hunks and rollback when the bounded
   previous content cannot be retained.

## Consequences

- Committing after a tool no longer makes its review number or card disappear.
- Every visible diff is tied to the exact message that produced it, including
  additions, deletions, and modifications.
- Rollback is explicit, idempotent, and refuses to overwrite later work.
- Review no longer promises to describe unrelated shell mutations; structured
  write/edit results are the durable review boundary.
- Snapshot bytes add host-owned local storage, bounded by file and diff caps.

## Alternatives rejected

- **Keep reading Git HEAD:** commits erase the evidence and cannot identify the
  message responsible for a later same-path edit.
- **Store only a renderer patch:** the renderer cannot safely restore files,
  and the patch would be lost on restart or session reload.
- **Rollback unconditionally:** it could overwrite a user's later edit or an
  external change, so the post-tool hash guard is mandatory.
