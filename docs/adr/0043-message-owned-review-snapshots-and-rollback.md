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

The previous Review implementation reconstructed each card from the current Git
working tree. A commit therefore removed the evidence for an earlier tool
message, and a later edit to the same path could make an old message appear to
describe work it never performed.

## Decision

1. After normal path authorization, before any `Write` or `Edit`, host-core
   captures the previous file bytes in a session-scoped snapshot outside the
   workspace.
2. The renderer derives `ReviewChangeCard` and the Review panel's chronological
   history from persisted tool messages only.
3. `review.rollback({sessionId, snapshotId})` is a host-owned operation.
4. Snapshot storage is bounded and session-owned:
   `<data_dir>/review-changes/<sessionId>/<snapshotId>/{before,meta.json}`.
5. Failed, denied, sensitive, or unresolvable operations do not create review
   records.

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
- **Store only a renderer patch:** the renderer cannot safely restore files, and
  the patch would be lost on restart or session reload.
- **Rollback unconditionally:** it could overwrite a user's later edit or an
  external change, so the post-tool hash guard is mandatory.

## Round review reader amendment

The native Review panel additionally groups persisted changes by user
conversation round and execution root/path. Latest means the newest user round
with recorded changes, not the most recently arriving tool result.

New snapshots retain bounded 1/3/5-line context hunks next to the existing
`before` rollback snapshot and optional execution-root metadata.
`review.context` reads these immutable hunks only; no full after-image cache is
created.
