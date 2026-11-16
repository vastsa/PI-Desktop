# ADR 0162: Cross-session A2A addressing

- Status: Superseded by ADR 0165
- Date: 2026-09-05
- Related: ADR 0062, ADR 0089, ADR 0147, ADR 0164, D318, D277
- Amends: ADR 0147. The local A2A broker, capability-token auth, typed parts,
  durable task lifecycle, and parent-cannot-call-A2A boundary are unchanged.
  Same-context-only addressing is lifted.

## Context

ADR 0147 bound every A2A agent to `contextId = sessionId` and refused
cross-context discovery, send, and task access with
`A2A_CROSS_CONTEXT_DENIED`, even though the broker is already process-global and
peer ids are only unique per session.

## Decision

Allow A2A discovery and addressing across sessions on the same host. Each Agent
Card carries `contextId` so a delegate can tell peers apart, task access becomes
membership in `requesterName` / `agentName`, `A2A_UNKNOWN_AGENT` covers strangers,
`A2A_CROSS_CONTEXT_DENIED` remains a documented but unproduced code, live peer ids
are uniquified at registration, and `a2a.task.event` / `a2a.push` carry
`recipientContextId` so a session runtime only delivers its own events.

## Consequences

Superseded by ADR 0165. Cross-session discovery, the unique live peer ids, and the
`recipientContextId` event shape were kept; nested delegation and any network A2A
binding remained out of scope, with parent-to-parent A2A decided in ADR 0164.
