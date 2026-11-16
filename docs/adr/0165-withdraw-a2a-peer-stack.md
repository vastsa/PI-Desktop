# ADR 0165: Withdraw the A2A / Peer coordination stack

- Status: Accepted
- Date: 2026-09-05
- Related: D326, D277, D318, D321, D325, ADR 0062, ADR 0089
- Supersedes: ADR 0147, ADR 0162, and ADR 0164. ADR 0138 and ADR 0140 remain
  superseded by ADR 0147; this ADR withdraws the replacement those records
  described. Historical ADR files are retained.

## Context

ADR 0138 introduced in-process peer messaging, ADR 0140 folded it into one
`Peer` tool, ADR 0147 replaced it with a host-core A2A broker, an `a2a.*` RPC
domain, durable `a2a_*` tables, and a delegate `A2A` tool, and ADR 0162 / ADR
0164 extended it to cross-session parents. That stack sat beside the existing
`Task` contract, added a protocol capability the rest of the app did not use, and
was easy for the model to miss or misuse, while concurrent delegates already
report through the parent.

## Decision

Remove the A2A / Peer coordination stack from the product.

1. **No A2A or Peer tool.** Neither name is a core Agent tool, an assignable
   subagent tool, or a `ToolSearch` result; a definition listing one is dropped
   with a parse warning like any unknown tool name.
2. **No broker.** The host-core `a2a` module, the in-memory registry, the
   in-process `SubagentMailbox`, every `a2a.*` RPC method, and the
   `a2a.task.event` / `a2a.push` notifications are deleted.
3. **No parent or sibling channel.** Concurrent delegates coordinate only by
   writing self-contained reports the parent collects through `Task*`.
4. **Protocol v11.** `PROTOCOL_VERSION` moves from 10 to 11, `capabilities` no
   longer advertises `"a2a"`, and a v10 host or client is rejected at handshake.
5. **Schema v13.** `SCHEMA_VERSION` moves from 12 to 13, `migrate_v12_to_v13`
   drops `a2a_tasks`, `a2a_messages`, `a2a_artifacts`, and `a2a_push_configs`,
   and fresh databases never create them.

Delegation itself (ADR 0062 / ADR 0089) is unchanged: `Task` still fans out
bounded workers, reports stay out of the parent context until `TaskWait`, and
builtins stay read-only by default.

## Consequences

- Cross-conversation and sibling messaging are gone; sessions share facts
  through the prompt, not a tool.
- The roundtable example plugin runs independent concurrent `Task`s and lets the
  parent synthesize the reports instead of calling `Peer` or `A2A`.
- Historical changelog entries for 0.11.3 and 0.12.0 stay as shipped history,
  product READMEs drop current A2A claims, and ADRs 0138, 0140, 0147, 0162, and
  0164 remain on disk as records.
