# ADR 0207: Allow Three Same-Path Mutation Recovery Failures

- Status: Accepted
- Date: 2026-09-10
- Related: D186, D379, ADR 0087, E2E-140, E2E-141

## Context

The line-anchored mutation guard previously terminated a prompt after two
counted failures for the same path. The first failure often exposes a syntax,
range, or provenance correction, while the second failure can still be the
agent applying that correction. Stopping at that point makes a bounded editing
mistake harder to recover from than necessary.

## Decision

Amend D186 and ADR 0087: a prompt may make three counted failed `Edit` calls on
one path before the repeat guard terminates the turn. A recognized shell patch
command uses the same three-failure limit under its patch-command key. The
first and second counted failures return their normal error-specific recovery
hints and leave the turn running; the third carries `terminate: true` and
finalizes the assistant row with `MUTATION_RETRY_BUDGET_EXHAUSTED`.

The existing rules remain unchanged: recoverable error codes each receive one
per-code grace, counters are scoped to the prompt and path, and a successful
mutation clears that path's failure history. Provider retry budgets and other
tool concurrency limits are unaffected.

## Consequences

- The model gets one additional bounded opportunity to correct an Edit or
  recognized shell patch failure.
- Persistent or guessing mutation loops still terminate deterministically.
- The runtime error message and every shipped locale must say three failures.
- No IPC, storage, host protocol, or tool result shape changes.

## Alternatives considered

- Keep the two-failure limit: rejected because the second correction attempt can
  still be an honest recovery after a distinct first error.
- Remove the limit: rejected because malformed or blind mutation loops must not
  consume an unbounded turn.

## Verification

- Runtime unit tests cover Edit, shell patch, per-code grace, reset after a
  successful mutation, and the visible terminating error row.
- E2E-140 and E2E-141 document the third-failure boundary.
