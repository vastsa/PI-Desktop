# ADR 0310: Keep local permission approvals pending until resolved

- Status: Accepted for implementation
- Date: 2026-09-29
- Amends: D005 / [ADR 0011](0011-host-rpc-and-storage-defaults.md)
- Related: D636, issue #1214, E2E-017

## Context

The local `ask` flow showed a 120-second countdown and then denied the request
in host-core, with the same deadline copied into the renderer card, the
pending-permission snapshot, and the transport budgets, so a user who missed the
card made an unintended decision.

## Decision

A local permission-gated `tools.execute` request stays pending until the user
chooses Allow once, Allow for session, or Deny, until the tool call or turn is
cancelled, or until the host or sidecar shuts down. The renderer shows no
countdown, host-core never expires these requests, `permissions.pending` returns
every open request without `timeoutMs`, `expiresAt`, or `remainingMs`, and the
transport sets no deadline for `tools.execute`. Tool execution budgets,
Plan/Goal approval lifetimes, and RACP broker lifetimes are unchanged.

## Consequences

- Users can leave a permission card unanswered without an automatic denial, at
  the cost of a turn that stays paused until explicit cancellation.
- The local permission wire shape loses its misleading expiry, while other RPCs
  keep their finite transport deadlines.
