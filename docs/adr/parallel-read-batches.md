# ADR: Ordered preparation and parallel read batches

- Status: Proposed
- Date: 2026-10-12

## Context

The runtime globally permits parallel execution but overrides every tool except
Task to sequential. pi consequently serializes independent Read/Glob/Grep calls.
Simply changing those flags is unsafe: file preflight currently changes the
parent prompt, including when invoked through delegated tool closures.

## Decision

Keep pi-agent-core 1.1.0 and its ordered preparation / concurrent execution /
ordered result submission contract. Centralize the Read/Glob/Grep/Task allowlist,
with unknown tools defaulting to sequential. Keep existing Host permission and
capacity ownership. Do not introduce another batch executor.

Move parent file preflight after mode and extension checks in beforeToolCall.
Use a weak argument-identity map to bind canonical parameters to the validated
call; unused records are collectible after cancellation or rejection. Direct
invocations still run preflight. Delegate preparation has an explicit prompt
sink, and AsyncLocalStorage preserves that sink for direct delegated executions
without sharing mutable current-agent state. Delegate prompt updates use the
same chronological system transcript sections as the parent.

## Consequences

Independent reads/searches overlap without changing writes or Bash policy.
Task/read mixed batches become concurrent. Delegate path rules now follow their
own ordered calls instead of mutating the parent. Instruction resolution claims
remain immutable, per-prompt cached promises; shared caching does not share the
prompt mutation sink. Source-order results still come from pi.

This step does not coordinate file writers across agents or grant directory
snapshots. Existing running file RPCs drain on Stop; finer cancellation and
file resource leases belong to separate changes. No dependency upgrade is needed:
the upstream baseline pins 1.1.0, whose batch contract was verified directly.

## Alternatives

- Parallelize execute while retaining prompt updates there: completion order
  would select sibling rules and delegates would still overwrite parent state.
- Serialize all reads behind a prompt mutex: would preserve the bottleneck.
- Fork pi's batch executor: duplicates an already-supported contract.
