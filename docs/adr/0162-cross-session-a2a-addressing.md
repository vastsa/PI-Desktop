# ADR 0162: Cross-session A2A addressing

- Status: Superseded by ADR 0165
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D318, D277, ADR 0147, ADR 0062, ADR 0089,
  `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, E2E-165, E2E-165b, E2E-165c
- Amends: ADR 0147. The local A2A broker, capability-token auth, typed parts,
  durable task lifecycle, and parent-cannot-call-A2A boundary are unchanged.
  Same-context-only addressing is lifted.

## Context

ADR 0147 bound every A2A agent to `contextId = sessionId` and refused
cross-context discovery, send, and task access with `A2A_CROSS_CONTEXT_DENIED`.

## Decision

Allow A2A discovery and addressing across sessions on the same host.

## Consequences

Superseded (Superseded by ADR 0165). The full record is in git history.
