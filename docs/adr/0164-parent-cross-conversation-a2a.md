# ADR 0164: Parent agents collaborate across conversations

- Status: Superseded by ADR 0165
- Date: 2026-09-05
- Amends: ADR 0147 (parent must not call `A2A`) and ADR 0162 (no messaging
  with the parent). Subagent sibling coordination is unchanged.
- Related: D321, D318, ADR 0147, ADR 0162, ADR 0062

## Context

ADR 0147 kept `A2A` out of the parent catalog so a parent could not open a
second channel to its own delegates, and ADR 0162 then let subagents reach peers
in other sessions but not the parent. Users wanted two sidebar conversations to
coordinate, not two nested workers.

## Decision

Each Agent-mode session runtime registered a parent A2A agent for its lifetime,
`A2A` became a core Agent-mode parent tool, kinds stayed separate so parents and
subagents could not address each other, inbound notes joined the next parent turn
as an inbox prefix, and reachability followed runtime lifetime.

## Superseded

ADR 0165 withdrew the whole A2A / Peer coordination stack, including the parent
agent card, the `A2A` tool, the broker, and the `a2a.*` RPC domain, and restored
`Task*` reports as the only delegate coordination channel.
