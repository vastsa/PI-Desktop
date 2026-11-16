# ADR 0138: Subagent Peer Messaging

- Status: Superseded by ADR 0147
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Related: D201, D277, ADR 0062, ADR 0089, ADR 0100, ADR 0140, ADR 0147,
  `03-runtime/02-agent-runtime.md` §5f / §5f.2, E2E-165
- Amends: nothing. ADR 0062's parent-only integration point and ADR 0089's
  background delegation lifecycle are both preserved; this adds an opt-in
  sibling channel beside them.

> Superseded by ADR 0147. The in-process `SubagentMailbox` and the peer tools
> this ADR introduced are removed and replaced by the A2A protocol stack: a
> host-core broker with durable tasks, typed message parts, agent-card
> discovery, and capability-token authorization over the existing JSON-RPC
> transport. Retained because the coordination failures it documents — stale
> premises under the path lock, disproved shared assumptions, duplicated
> searches — are exactly what the A2A stack now addresses, and because the
> invariants it froze (no forged sender, delegate-only tool, settled delegates
> leave) carry forward unchanged.

## Context

Delegation as built by ADR 0062 and ADR 0089 has exactly one integration point:
the parent.

- Two write-capable delegates discover mid-run that they need the same file.
- One delegate disproves an assumption every brief was written against.
- One delegate has already found the fact another is about to spend fifteen tool
  calls searching for.

## Decision

Add a **session-scoped peer mailbox** and three delegate-only tools, opt-in per
definition.

## Consequences

Superseded (Superseded by ADR 0147). The full record is in git history.
