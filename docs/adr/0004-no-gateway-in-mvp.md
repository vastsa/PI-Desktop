# ADR 0004: No remote Gateway in the MVP

- Status: Accepted
- Date: 2026-07-25

## Context

Products such as LiveAgent ship a remote WebUI/Gateway, so the first release had
to decide whether remote control of the local agent belongs in scope.

## Decision

The MVP builds no remote Gateway and no browser-based remote control. The
local-first desktop loop and its permission model are proven first; a remote link
would add authentication, synchronization, and security work ahead of that.

## Consequences

- Scope converges and the security model stays simple.
- No browser-based remote control of the local agent in the short term.
- Remote capability needs its own ADR and milestone.
