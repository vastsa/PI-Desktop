# ADR 0175: Explain quiet active turns with live agent activity status

- Status: Accepted
- Date: 2026-09-07

## Context

The transcript shows a compact `Working…` row before the first model or tool event,
but a provider request can spend a long interval before that event, and a retry
backoff or a parent-side delegated-task wait carries no row at all. The only signals
were the Stop button and a local timer, so users could not tell a normal wait from a
retry or a delegation wait (issue #56).

## Decision

Extend the normalized `status` event with an optional runtime-owned `AgentActivity`
value. `starting` covers the prompt handoff, `waiting-model` runs from issuing a
provider request until the first assistant event, `retrying` covers an abortable
backoff and carries the attempt number and delay, and `waiting-subagents` covers
parent-side convergence with the number of running targets. The sidecar emits these
from the boundaries that already own provider requests, retry delays, and
delegation waits, and clears them when output starts or the turn terminates. The
renderer keeps the latest status per session and renders a compact localized inline
row with a monotonic phase timer; it claims no completion percentage and leaves Stop
and abort semantics alone.

## Consequences

- A quiet turn explains its runtime-owned wait without duplicate progress chrome,
  and a retry backoff becomes observable while staying cancellable.
- Status is keyed by session id and cleared on terminal events and deletion, so
  session switching stays isolated.
- The protocol stays coarse: provider internals and child-agent events remain out of
  the renderer unless they explain one of these waits.
