# ADR 0140: Fold the Three Peer Tools Into One `Peer` Tool

- Status: Superseded by ADR 0147
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Related: D277, ADR 0138, ADR 0062, ADR 0089, ADR 0147,
  `03-runtime/02-agent-runtime.md` §5f, E2E-165, E2E-165b
- Amends: ADR 0138 clauses 2 and 3. The mailbox semantics, the caps, and every
  boundary ADR 0138 established are unchanged; this decision only changes the
  *tool surface* a delegate declares and calls.

> Superseded by ADR 0147. The single `Peer` tool this ADR settled on is
> replaced by the `A2A` tool (actions `discover | send | get | wait | cancel`)
> against a host-core A2A broker. Retained because the counting argument for one
> tool over three carries into the A2A tool surface, and because
> `SUBAGENT_A2A_TOOLS = ["A2A"]` is the direct successor of the
> `SUBAGENT_PEER_TOOLS = ["Peer"]` mapping this ADR defined.

## Context

ADR 0138 introduced peer messaging as three delegate-only tools — `PeerSend`,
`PeerInbox` and `PeerWait` — declarable in a definition's `tools:` list.

## Decision

Fold the three tools into **one `Peer` tool** selected by a required `action`
parameter:

## Consequences

Superseded (Superseded by ADR 0147). The full record is in git history.
