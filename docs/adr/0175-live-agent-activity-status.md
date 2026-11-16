# ADR 0175: Explain quiet active turns with live agent activity status

- Status: Accepted
- Date: 2026-09-07

## Context

The transcript already shows a compact `Working…` row before the first model or
tool event and inline rows for concrete thinking and tool activity. A provider
request can still spend a long interval before its first event, and a bounded
retry backoff or parent-side delegated-task wait can contain no transcript row.

## Decision

Extend the existing normalized `status` event with an optional runtime-owned
`AgentActivity` value:

1. `starting` covers the initial prompt handoff.
2. `waiting-model` starts when a provider request is issued and lasts until the
   first assistant event.
3. `retrying` covers an abortable provider backoff and carries the attempt
   number and calculated delay when available.
4. `waiting-subagents` covers parent-side convergence on delegated work and
   carries the number of running targets.

The sidecar emits these phases from the same boundaries that own provider
requests, retry delays, and delegation waits. It clears the phase when assistant
output starts or the turn reaches a terminal event.

## Consequences

- A quiet active turn explains its current runtime-owned wait without adding
  decorative or duplicate progress chrome.
- Retry lifecycle remains silent in the transcript, while the retry backoff
  becomes observable and remains cancellable.
- Session switching remains isolated because status is keyed by session id and
  is cleared with terminal events and session deletion.
- The status is intentionally coarse: provider internals and subagent child
  events remain out of the renderer protocol unless they explain one of these
  user-visible waits.

## Alternatives

### Keep the generic Working row for every wait

Rejected because it does not distinguish a normal provider wait from a retry or
delegation wait, which was the ambiguity reported in Issue #56.

### Add a permanent multi-step progress card

Rejected because agent turns do not have a reliable total-step or percentage
model, and the existing active-turn contract keeps the lower transcript surface
inline and compact.

### Emit raw provider or child-agent events

Rejected because it would expose unstable implementation details and create a
larger protocol surface than the user needs.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-008c, E2E-094)
- GitHub Issue #56
