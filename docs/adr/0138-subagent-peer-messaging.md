# ADR 0138: Subagent Peer Messaging

- Status: Superseded by ADR 0147
- Date: 2026-08-31
- Related: ADR 0062, ADR 0089, ADR 0100, ADR 0140, ADR 0147, D201, D277
- Amends: nothing. ADR 0062's parent-only integration point and ADR 0089's
  background delegation lifecycle are both preserved; this adds an opt-in
  sibling channel beside them.

## Context

Delegates only talked to the parent, so concurrent workers could not correct a
stale premise, disprove a shared assumption, or share a fact before each of them
paid for the same search, while routing notes through the parent was blocked by
`TaskWait` and would defeat the point of delegation.

## Decision

Add a session-scoped `SubagentMailbox` with three opt-in, delegate-only tools —
`PeerSend`, `PeerInbox`, and `PeerWait` — addressed by per-delegation peer id,
with the sender bound at spawn time, bounded message and send counts, destructive
draining, and membership tied to running delegates.

## Consequences

Superseded by ADR 0147, which removed the in-process mailbox and these tools in
favor of the A2A stack: a host-core broker with durable tasks, typed message
parts, agent-card discovery, and capability-token authorization. The invariants
this record froze carry forward unchanged — no forged sender, delegate-only
tools, and departed delegates leave the mailbox — and the coordination failures it
documented are what A2A now addresses.
