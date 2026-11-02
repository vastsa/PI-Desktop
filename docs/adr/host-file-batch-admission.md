# ADR: Host file identities and ordered batch admission

- Status: Proposed
- Date: 2026-10-30
- Related: #1982, #1908, ADR 0062, ADR 0329, parallel-read-batches

## Context

The first #1982 candidate classified file conflicts using lexical path keys and
a basename fallback. A differently named symbolic link or hard link bypasses
that rule. Sidecar PathMutex uses lexical keys too; Host's per-session mutation
cap excludes a second write, not a concurrent read. Independent-path read/write
parallelism therefore needs trusted resource identity before it can be safe.

The executor must also preserve the assistant's source order. Locking only on
RPC arrival can let a later approved call run before an earlier pending one.
File bodies use spawn_blocking, so cancelling the transport waiter is not proof
that disk work has stopped. Review snapshots and rollback are filesystem work,
not separate exceptions to the exclusion rule.

## Decision

Host owns resource classification and admission. Runtime registers only logical
calls in pi's ordered prepare phase and seals the batch before dispatch. The
five version-1 internal methods are tools.fileBatchCapabilities, Register,
Seal, Abandon and Close (each with the full tools.fileBatch prefix). A ticket
binds session, optional delegation, batch/ordinal, tool call/name and normalized
arguments. It is single-use and is not an access permission. Registration does
no file lookup and takes no execution capacity. Unstarted failed calls are
abandoned and turn-end closes metadata; running work cannot be released by
close or by metadata expiry.

Host applies existing permissions before classification. Unknown earlier calls
conservatively block potentially conflicting same-batch successors. Approved
calls use native object IDs from pinned handles, plus resolved path addresses.
Equal IDs conflict across roots; roots are not namespaces for physical IDs.
Windows uses local-disk volume/FILE_ID_INFO; supported Unix local filesystems use
dev/ino. Missing/unknown targets, structural edits and named registers use a
Host-wide file-domain fence. Searches use that domain shared. Permission and
I/O failures still fail in their original execution path; unknown identity is
never used as evidence of independence.

ToolBudget checks batch predecessors, active resources, conflicting waiters and
capacity in one synchronous reservation. No capacity is held while awaiting a
resource. Source predecessors may bypass a later same-batch RPC-arrival waiter;
otherwise a reversed arrival could deadlock. Conflicting later shared requests
do not bypass an exclusive waiter. Existing capacity limits and 30-second
HOST_OVERLOADED behavior stay unchanged. Local diagnostics report total
admission wait and the initial reason, not invented non-overlapping timings.

After admission, the persisted workspace binding and resource identity/address
are revalidated before snapshots and again in the blocking body. A changed
binding fails before mutation without replay. The actual blocking task retains
an Arc of the execution permit even if its RPC future is cancelled. Snapshot,
execution, Hashline updates and review finalization share the lease; rollback
also joins the domain without holding AppState while waiting.

On the negotiated path Host resources replace sidecar PathMutex around file
execution, avoiding a second lock-order authority. Legacy calls retain the old
sidecar policy; calls without tickets still take Host resource leases but lack
batch source-order metadata. The capability is stable for a runtime/connection
so a later parent prompt cannot switch a live delegate's lock protocol.
Tickets travel in AsyncLocalStorage, not a shared provider-call-ID map.

Remote workspaces do not yet expose this execution-end protocol. They and old
Hosts retain sequential write batches; the desktop never stats a remote path
locally. Bash, Task's delegation lifecycle, plugin/MCP policy, write quotas and
persistence formats are unchanged. Coordination covers participating file
tools and rollback in one Host process, not arbitrary external writers, shell
processes or other Host instances. It is not OS-wide transaction isolation or a
new defense against malicious external path replacement.

## Alternatives

- Realpath/basename only: misses hard links and unknown filesystem identities.
- Return an identity token and keep arrival-order admission: loses source order
  when approvals/RPCs arrive in another order; stale identities can also escape.
- Keep every write as a batch-local full barrier: safe fallback, but discards
  independent-file read/write overlap even on a capable local Host.
- Reimplement pi execution: duplicates its ordered preparation/result contract.
- Adopt the whole #1908 roadmap: unrelated quota, background-job and MCP changes
  are not required to repair the current concurrency boundary.

## Consequences and verification

This is a cross-runtime/Host protocol amendment, not a TS-only optimization.
It adds bounded process-local metadata and registration/sealing overhead, which
must be included in performance measurements. It does not raise per-session
write throughput: one mutation per session still applies. Registry bounds and
unknown identities may reject/degrade work conservatively.

Regression evidence must cover actual differently named links in both orders,
reversed RPC/approval arrival, parent/delegate wiring, cross-session aliases,
independent resources, cancellation during blocking work, queue cleanup,
permission denial, argument tampering/replay, review rollback and legacy remote
fallback. Diagrams and source inspection are not substitutes for execution.
See E2E-TOOLS-parallel-read-batches and the corresponding Rust/runtime tests.
