# ADR 0043: Message-owned review snapshots and guarded rollback

- Status: Accepted
- Date: 2026-08-02
- Amended: 2026-10-22
- Supersedes: ADR 0042's Git-dependent review source, D098, and D179
- Amended by: [ADR 0087](0087-line-anchored-edit-contract.md)
- Related: [03-tools-and-permissions](../spec/03-runtime/03-tools-and-permissions.md) · [06-host-rpc-protocol](../spec/03-runtime/06-host-rpc-protocol.md) · [E2E-057](../spec/06-delivery/04-e2e-test-plan.md)

## Context

The previous Review implementation rebuilt each card from the current Git working
tree, so a commit removed the evidence for an earlier tool message and a later
edit to the same path could make an old message describe work it never performed.
There was no safe way to restore one message's previous file content, and review
is a conversation feature, so its evidence must belong to the message that
produced it.

## Decision

1. After normal path authorization and before any `Write` or `Edit`, host-core
   captures the previous file bytes in a session-scoped snapshot outside the
   workspace, and a successful workspace, scratch, visualization, or approved
   external mutation writes bounded `details.review` evidence into the tool
   result with snapshot and message ids, path, operation, status, counts, hunks,
   rolled-back state, and reversibility.
2. The renderer derives `ReviewChangeCard` and the Review panel history from
   persisted tool messages only, never from a current Git diff, and a
   review-backed `Write`/`Edit` renders as one tool-level row that stays visible
   after commit, workspace switching, and restart.
3. `review.rollback({sessionId, snapshotId})` is host-owned: it verifies that the
   current file hash equals the recorded post-tool hash, returns `conflict`
   without touching the file otherwise, restores the previous bytes or removes a
   created file, and persists `state: "rolledBack"`.
4. Snapshots are session-owned and bounded, removed with the session and swept at
   startup for missing sessions, while forked transcripts keep their evidence but
   mark rollback unavailable.
5. Failed, denied, sensitive, or unresolvable operations create no record, and
   non-workspace snapshots are readable evidence rather than path grants, so they
   are non-reversible.

## Consequences

- Committing no longer makes a review number or card disappear, and every diff
  is tied to the message that produced it.
- Rollback is explicit, idempotent, and refuses to overwrite later work.
- Review covers structured `Write`/`Edit` results rather than unrelated shell
  mutations, and snapshot bytes add bounded host-owned storage.

## Round review reader amendment

The native Review panel groups persisted changes by user conversation round and
execution root, where latest means the newest user round with recorded changes
and not the most recently arriving tool result, and delegate ancestry plus the
Host message-turn index preserve ownership of late results. New snapshots retain
bounded context hunks read through `review.context`, and the execution root is
provenance rather than permission, so rollback cannot write into another
checkout.
