# ADR 0207: Allow Three Same-Path Mutation Recovery Failures

- Status: Accepted
- Date: 2026-09-10
- Related: D186, D379, ADR 0087, E2E-140, E2E-141

## Context

The line-anchored mutation guard terminated a prompt after two counted failures
for the same path, although the first failure usually exposes a syntax, range,
or provenance correction and the second can be the agent applying it.

## Decision

Amend D186 and ADR 0087: a prompt may make three counted failed `Edit` calls on
one path, and a recognized shell patch command shares that limit under its
patch-command key. The first two failures return their error-specific recovery
hints and leave the turn running; the third carries `terminate: true` and
finalizes the assistant row with `MUTATION_RETRY_BUDGET_EXHAUSTED`. Recoverable
codes keep one per-code grace, counters stay scoped to the prompt and path, a
successful mutation clears that path's history, and provider retry and
concurrency budgets are untouched.

### Delegate ownership correction (2026-10-07)

The prompt scope is the executing agent, not the whole session, so recovery keys
include the parent or delegation owner instead of letting concurrent delegates
spend one another's attempts. Settlement releases a delegate's counters and
graces, a terminal tool error is carried into the delegate result, and the
failed chain stays resumable through the existing Task flow.

## Consequences

- The model gets one more bounded correction attempt per path.
- Persistent or guessing loops still terminate deterministically, and every
  shipped locale must say three failures.
- No IPC, storage, host protocol, or tool result shape changes.

## Alternatives

- Keep the two-failure limit: rejected, an honest second correction can follow a
  distinct first error.
- Remove the limit: rejected, blind mutation loops must stay bounded.
