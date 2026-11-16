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

ADR 0138 introduced in-process subagent peer messaging (`PeerSend` / `PeerInbox`
/ `PeerWait`). ADR 0140 folded those into one `Peer` tool.

## Decision

Remove the A2A / Peer coordination stack from the product:

1. **No A2A or Peer tool.** Neither name is a core Agent tool, an assignable
   subagent tool, or a `ToolSearch` result.
2. **No broker.** Delete the host-core `a2a` module, the in-memory registry, the
   leftover in-process `SubagentMailbox`, and every `a2a.*` RPC method and
   `a2a.task.event` / `a2a.push` notification.
3. **No parent or sibling channel.** Concurrent delegates coordinate only by
   writing self-contained reports the parent collects through `Task*`.
4. **Protocol v11.** Handshake `PROTOCOL_VERSION` moves from 10 to 11.
5. **Schema v13.** `SCHEMA_VERSION` moves from 12 to 13.

Delegation itself (ADR 0062 / ADR 0089) is unchanged: `Task` still fans out
bounded workers, reports still stay out of the parent model context until
`TaskWait`, and builtins stay read-only by default.

## Consequences

- Cross-conversation and sibling messaging are gone.
- The roundtable example plugin no longer tells delegates to call `Peer` or
  `A2A`.
- Historical changelog entries for 0.11.3 (peer messaging) and 0.12.0 (A2A) stay
  as shipped history.
- ADRs 0138, 0140, 0147, 0162, and 0164 remain on disk as records.
