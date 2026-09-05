# ADR 0165: Withdraw the A2A / Peer coordination stack

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D326, D277, D318, D321, D325, ADR 0062, ADR 0089,
  `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/06-host-rpc-protocol.md` §3–§4, E2E-165
- Supersedes: ADR 0147, ADR 0162, and ADR 0164. ADR 0138 and ADR 0140 remain
  superseded by ADR 0147; this ADR withdraws the replacement those records
  described. Historical ADR files are retained.

## Context

ADR 0138 introduced in-process subagent peer messaging (`PeerSend` /
`PeerInbox` / `PeerWait`). ADR 0140 folded those into one `Peer` tool. ADR
0147 replaced that mailbox with a host-core Agent2Agent (A2A) broker, an
`a2a.*` RPC domain, durable `a2a_*` SQLite tables, and a delegate `A2A` tool.
ADR 0162 then lifted same-session-only addressing; ADR 0164 / D325 gave
Agent-mode parents a core `A2A` tool so conversations could coordinate.

That stack is no longer wanted. Sibling and parent-to-parent channels sat
beside the existing `Task` / `TaskWait` / `TaskList` / `TaskStop` contract,
added a protocol capability the rest of the app did not use, and were easy
for the model to miss or misuse. Concurrent delegates already report through
the parent; that is enough.

## Decision

Remove the A2A / Peer coordination stack from the product:

1. **No A2A or Peer tool.** Neither name is a core Agent tool, an assignable
   subagent tool, or a `ToolSearch` result. A definition that lists `A2A` or
   `Peer` is treated like any other unknown tool name: dropped with a parse
   warning.
2. **No broker.** Delete the host-core `a2a` module, the in-memory registry,
   the leftover in-process `SubagentMailbox`, and every `a2a.*` RPC method
   and `a2a.task.event` / `a2a.push` notification.
3. **No parent or sibling channel.** Concurrent delegates coordinate only by
   writing self-contained reports the parent collects through `Task*`.
   Parents do not discover, message, or wait on other conversations.
4. **Protocol v11.** Handshake `PROTOCOL_VERSION` moves from 10 to 11. The
   `capabilities` array no longer advertises `"a2a"`. A v10 host or client is
   rejected at handshake, the same exact-match rule as every prior bump.
5. **Schema v13.** `SCHEMA_VERSION` moves from 12 to 13.
   `migrate_v12_to_v13` drops the A2A tables (`a2a_tasks`, `a2a_messages`,
   `a2a_artifacts`, `a2a_push_configs`). Fresh databases never create them.
   The v11→v12 step remains in the chain as a version-only bump so existing
   backups and chained migrations keep working; it no longer creates tables
   that v13 would immediately drop.

Delegation itself (ADR 0062 / ADR 0089) is unchanged: `Task` still fans out
bounded workers, reports still stay out of the parent model context until
`TaskWait`, and builtins stay read-only by default.

## Consequences

- Cross-conversation and sibling messaging are gone. Users who want two
  sessions to share facts do so in the prompt, not through a tool.
- The roundtable example plugin no longer tells delegates to call `Peer` or
  `A2A`. It runs independent concurrent `Task`s and has the parent synthesize
  the reports, optionally feeding earlier reports into a later round's brief.
- Historical changelog entries for 0.11.3 (peer messaging) and 0.12.0 (A2A)
  stay as shipped history. Product READMEs drop current A2A claims.
- ADRs 0138, 0140, 0147, 0162, and 0164 remain on disk as records.
