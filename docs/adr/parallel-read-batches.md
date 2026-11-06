# ADR: Ordered preparation and parallel file batches

- Status: Proposed
- Date: 2026-10-12
- Amended: 2026-10-30 by #1982; see [Host file admission](host-file-batch-admission.md)

## Context

Independent Read/Glob/Grep calls were serialized. Simply changing execution
flags was unsafe because preflight mutated the prompt in completion order and
Task could start a writable delegate beside a parent read. The initial #1982
amendment later tried lexical-path claims for Write/Edit; review demonstrated
that different file names can reference the same object.

## Decision

Use pi-agent-core's ordered preparation, concurrent execution and source-order
result submission contract. Native path instruction preparation follows parent
mode/extension checks; children only mutate their own prompt. Prepared argument
identity keeps execution on the same normalized parameters. Direct calls retain
preflight. Do not fork pi or add another executor.

Read/Glob/Grep remain parallel candidates. A supported local Host allows
Write/Edit to join; legacy and remote Hosts retain sequential writes. Task-only
fan-out is preserved; Task mixed with any file tool keeps the entire batch
sequential. Reads/searches after a writable Task still wait for that delegate's
completion; Task itself returns its started notice immediately.

Eligible parallel file calls register in source order, seal before dispatch,
and carry Host tickets. The Host owns actual identity, conflicts, capacity and
execution lease lifetime as specified in the companion ADR. Basename and
lexical keys no longer authorize overlap. Outer executor cleanup includes
argument failures, mode denials, cancellation and calls that never reach Host.
Batch-end cleanup only abandons unstarted records, never active disk work.

## Consequences

Independent known-file reads and writes may overlap while aliases keep source
order. Uncertain paths, namespace changes, searches and registers conservatively
coordinate through the Host file domain. Per-session write capacity remains
one. Results still enter the model in source order. Task/Bash semantics and
permissions are unchanged. Legacy PathMutex behavior remains only on the legacy
path; the negotiated path uses the Host authority for participating parent,
delegate and session calls.

Regression tests must distinguish RPC submission from actual file-body order.
Real Host tests cover differently named links and reversed RPC arrival; a
blocking-pool gate proves cancellation cannot release a running file lease.
Local-provider E2E covers parent/delegate wiring, results, real-tag Edit,
approvals, aliases and rollback. Performance measurements include metadata RPCs
and do not claim the diagram's illustrative timings as observed throughput.

## Alternatives

- Completion-order preflight: sibling calls race to choose prompt instructions.
- Sidecar lexical locks: miss aliases and other sessions.
- Write-only Host capacity: does not exclude a read of the same file.
- Waiting/releasing only inside the builtin body: validation/mode errors can
  strand registered successors before reaching that body.
