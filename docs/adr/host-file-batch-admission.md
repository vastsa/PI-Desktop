# ADR: Host file identities and ordered batch admission

- Status: Proposed
- Date: 2026-10-30
- Related: #1982, #1908, ADR 0062, ADR 0329, parallel-read-batches

## Context

The first #1982 candidate classified file conflicts using lexical path keys and
a basename fallback. A differently named symbolic link or hard link bypasses
that rule.

## Decision

Host owns resource classification and admission. Runtime registers only logical
calls in pi's ordered prepare phase and seals the batch before dispatch.

Host applies existing permissions before classification. Unknown earlier calls
conservatively block potentially conflicting same-batch successors.

## Alternatives

- Realpath/basename only: misses hard links and unknown filesystem identities.
- Return an identity token and keep arrival-order admission: loses source order
  when approvals/RPCs arrive in another order; stale identities can also escape.
- Keep every write as a batch-local full barrier: safe fallback, but discards
  independent-file read/write overlap even on a capable local Host.
- Reimplement pi execution: duplicates its ordered preparation/result contract.

## Consequences and verification

This is a cross-runtime/Host protocol amendment, not a TS-only optimization.

Regression evidence must cover actual differently named links in both orders,
reversed RPC/approval arrival, parent/delegate wiring, cross-session aliases,
independent resources, cancellation during blocking work, queue cleanup,
permission denial, argument tampering/replay, review rollback and legacy remote
fallback.
