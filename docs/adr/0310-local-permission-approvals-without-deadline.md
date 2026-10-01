# ADR 0310: Keep local permission approvals pending until resolved

- Status: Accepted for implementation
- Date: 2026-09-29
- Deciders: PI-Desktop maintainers
- Amends: D005 / [ADR 0011](0011-host-rpc-and-storage-defaults.md)
- Related: D636, issue #1214, E2E-017

## Context

The local `ask` permission flow displayed a 120-second countdown and then
denied a request in host-core. The same deadline was copied into the renderer
card, the pending-permission snapshot, and the RPC transport budgets. A user
who did not notice the card in time therefore made an unintended decision, and
the visible card disappeared even though the user had not acted.

## Decision

Local permission-gated `tools.execute` requests remain pending until one of
these explicit lifecycle events occurs:

- the user chooses Allow once, Allow for session, or Deny;
- the tool call or turn is cancelled; or
- the host / sidecar process shuts down.

The renderer shows no countdown. Host-core does not expire or sweep local
permission requests, and `permissions.pending` returns every open request
without `timeoutMs`, `expiresAt`, or `remainingMs`. The transport does not set
a deadline for `tools.execute`; cancellation and process-close handling remain
the liveness paths. Tool-specific execution budgets, Plan/Goal contract
approval lifetimes, and the separate RACP approval broker lifetimes are not
changed by this decision.

## Consequences

- Users can leave a permission card unanswered without an automatic denial.
- An unattended permission request can keep its agent turn paused, so explicit
  cancellation remains available and must continue to wake the host waiter.
- The local permission wire shape is simplified and no longer carries a
  misleading expiry time.
- A lost host response is still bounded by process-close handling; ordinary
  non-tool RPCs retain their finite transport deadlines.

## Verification

`permissions.rs` covers resolving a request after the old 120-second boundary,
`parent-host-proxy.test.ts` covers indefinite tool transport waits,
`permission-inline.test.mjs` covers the no-countdown card contract, and the
host RPC test covers pending snapshots without expiry fields.
