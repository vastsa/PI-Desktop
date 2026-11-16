# ADR 0004: No remote Gateway in the MVP

- Status: Accepted
- Date: 2026-07-25

## Context

Products such as LiveAgent provide a remote WebUI/Gateway. Whether PI-Desktop
should add remote control capability in the first phase is a trade-off that
needs to be made.

## Decision

The MVP will **not** build a remote Gateway / browser-based remote control.

## Rationale

1. It conflicts in priority with the local-first desktop closed-loop goal
2. A remote link would significantly increase authentication, synchronization,
   and security complexity
3. We should first prove that the local agent UX and permission model hold up

## Consequences

### Positive
- Scope convergence
- Simpler security model

### Negative
- No browser-based remote control of the local agent in the short term

## Follow-up

If remote capability is to be built, a separate ADR must be added, with its own
dedicated milestone.
