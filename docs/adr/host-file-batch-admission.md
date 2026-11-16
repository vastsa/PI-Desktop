# ADR: Host file identities and ordered batch admission

- Status: Proposed
- Date: 2026-10-30
- Related: #1982, #1908, ADR 0062, ADR 0329, parallel-read-batches

## Context

The first #1982 candidate classified file conflicts by lexical path keys with a
basename fallback, which a differently named symbolic or hard link bypasses, and
Sidecar PathMutex uses lexical keys too while Host's per-session mutation cap
excludes a second write rather than a concurrent read. Parallel independent-path
access therefore needs trusted resource identity, and source order must survive
because locking on RPC arrival lets a later approved call run before an earlier
pending one. File bodies use `spawn_blocking`, so cancelling the transport waiter is
not proof that disk work stopped, and review snapshots and rollback are filesystem
work, not exceptions to exclusion.

## Decision

Host owns resource classification and admission. Runtime registers only logical
calls in pi's ordered prepare phase and seals the batch before dispatch through the
five version-1 methods `tools.fileBatchCapabilities`, `Register`, `Seal`, `Abandon`,
and `Close`. A ticket binds session, optional delegation, batch/ordinal, tool
call/name, and normalized arguments; it is single-use and is not an access
permission. Registration does no file lookup and takes no capacity, unstarted failed
calls are abandoned, turn-end closes metadata, and running work cannot be released
by close or metadata expiry.

Host applies existing permissions before classification, and unknown earlier calls
conservatively block potentially conflicting same-batch successors. Approved calls
use native object IDs from pinned handles plus resolved path addresses: equal IDs
conflict across roots, because roots are not namespaces for physical IDs. Windows
uses local-disk volume/`FILE_ID_INFO` and supported Unix filesystems dev/ino, while
missing or unknown targets, structural edits, and named registers use a Host-wide
file-domain fence that searches share. Permission and I/O failures keep failing in
their original path, and unknown identity is never evidence of independence.

`ToolBudget` checks batch predecessors, active resources, conflicting waiters, and
capacity in one synchronous reservation without holding capacity while awaiting a
resource. Source predecessors may bypass a later same-batch RPC-arrival waiter to
avoid a reversed-arrival deadlock, shared requests do not bypass an exclusive
waiter, and global limits with 30-second `HOST_OVERLOADED` behavior are unchanged.

After admission the persisted binding and resource identity are revalidated before
snapshots and again in the blocking body, the blocking task keeps an `Arc` of its
permit even when the RPC future is cancelled, and snapshot, execution, Hashline
updates, and review finalization share one lease. On the negotiated path Host
resources replace sidecar PathMutex, legacy calls keep the sidecar policy, and the
capability is stable per runtime and connection so a live delegate cannot switch
protocol mid-turn. Remote workspaces keep sequential write batches; Bash, plugin/MCP
policy, and persistence formats are unchanged, and coordination covers one Host
process, not arbitrary external writers.

## Consequences

- This is a cross-runtime/Host protocol amendment, not a TS optimization: it adds
  bounded process-local metadata and registration/sealing overhead that must appear
  in performance measurements.
- Identified local writes with validated tickets may share two session mutation
  slots, still bounded by two global mutations, while uncoordinated calls stay
  single-write and exclude coordinated writes symmetrically; eligibility uses
  immutable request facts, and registry bounds may reject work conservatively.

## Alternatives

- Realpath/basename only: misses hard links and unknown identities.
- Return an identity token and keep arrival-order admission: loses source order and
  lets stale identities escape.
- Keep every write a batch-local full barrier, or adopt the whole #1908 roadmap: the
  first discards independent-file overlap, the second adds unrelated quota,
  background-job, and MCP changes.
