# ADR 0140: Fold the Three Peer Tools Into One `Peer` Tool

- Status: Superseded by ADR 0147
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Related: D277, ADR 0138, ADR 0062, ADR 0089, ADR 0147,
  `03-runtime/02-agent-runtime.md` §5f, E2E-165, E2E-165b
- Amends: ADR 0138 clauses 2 and 3; the mailbox semantics, caps, and every other
  boundary ADR 0138 established stay unchanged.

> Superseded by ADR 0147, which replaces the single `Peer` tool with the `A2A`
> tool (actions `discover | send | get | wait | cancel`) against a host-core A2A
> broker. Retained because the counting argument for one tool over three carries
> into that surface, and `SUBAGENT_A2A_TOOLS = ["A2A"]` directly succeeds the
> `SUBAGENT_PEER_TOOLS = ["Peer"]` mapping defined here.

## Context

ADR 0138 introduced peer messaging as three delegate-only tools — `PeerSend`,
`PeerInbox`, and `PeerWait` — so an opting-in delegate declared three names for
one capability, inflating declared tool counts and the parent's `Task` catalog.
The operations are mutually exclusive per call, which is the shape an `action`
parameter serves.

## Decision

Fold them into one **`Peer`** tool selected by a required `action` of `send`,
`inbox`, or `wait`. `SUBAGENT_PEER_TOOLS` became `["Peer"]`, an omitted or
unknown `action` fell back to the never-blocking `inbox`, and the tool stayed
built per delegate, closed over the runtime-supplied peer id, and absent from
`toolCatalog`.
