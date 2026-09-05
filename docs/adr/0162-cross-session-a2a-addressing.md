# ADR 0162: Cross-session A2A addressing

- Status: Accepted
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
That matched the in-process mailbox it replaced, which was session-scoped by
construction.

The broker itself is already process-global: one in-memory registry in
host-core, one sidecar JSON-RPC pipe, and one `DesktopAgentRuntime` per
session. Agents from different sessions already sit in the same map; isolation
was a filter. Concurrent work in two open sessions therefore cannot share a
fact, a file claim, or a roundtable seat even though both delegates are local
to the same host.

The remaining risk is identity, not transport. Peer ids are unique per session
(`discussant`, `discussant-2`) but not across sessions, so two chats can both
run `discussant`. Tasks store `agentName` / `requesterName` as those ids, and
the sidecar broadcasts `a2a.task.event` to every session runtime. A naive lift
of the filter would let the wrong `discussant` read a task or wake on the
other session's event.

## Decision

Allow A2A discovery and addressing across sessions on the same host.

1. **`a2a.agents.list` returns every other live agent**, not only the caller's
   `contextId`. Each Agent Card carries `contextId` (the session id it
   registered under) so a delegate can tell same-session peers from
   other-session peers. The caller's own card stays excluded.
2. **`a2a.message.send` may address any registered peer.** When `to` is
   omitted, the broker still prefers a same-session peer (preserving today's
   single-other-peer default) and only then a unique other-session peer.
3. **Task access is membership, not context.** The caller must be the task's
   `requesterName` or `agentName`. A stranger — same session or not — still
   fails with `A2A_UNKNOWN_AGENT`. `A2A_CROSS_CONTEXT_DENIED` is kept in the
   error-code list for wire compatibility and is no longer produced.
   `contextId` on the task remains the requester's session id and still caps
   `A2A_MAX_TASKS_PER_CONTEXT`.
4. **Live peer ids are unique across the registry.** On `a2a.agents.register`,
   if `card.name` is already taken the broker suffixes it (`discussant-2`, …)
   and returns the uniquified `agentId`. The runtime adopts that id for the
   delegate's A2A tool, wait queue, and prompt, so `agentName` / `requesterName`
   on a task cannot collide with another live agent.
5. **Events carry `recipientContextId`.** `a2a.task.event` and `a2a.push` are
   shaped `{ recipient, recipientContextId, contextId, … }`. Each session
   runtime delivers an event only when `recipientContextId` equals its
   `sessionId` (an omitted field keeps today's same-session delivery). This
   stops a broadcast on the shared sidecar pipe from queueing work for the
   wrong session.
6. **Unchanged boundaries.** The `A2A` tool stays out of the parent's
   `toolCatalog`. A settled delegate is deregistered. There is still no
   messaging with the parent, no nested delegation, and no remote or
   cross-machine transport.

## Consequences

- Two A2A-capable delegates in different open sessions can discover each
  other, create a durable task, and complete the counterpart round-trip.
- Same-session A2A is unchanged for the common case: unique names, omitted
  `to` picks the other local peer, events still wake the local waiter.
- A definition named `discussant` in a second session may register as
  `discussant-2` when the first session already holds `discussant`. The
  delegate is told its assigned peer id.
- `A2A_CROSS_CONTEXT_DENIED` remains a documented code but is unused. New
  cross-session failures are `A2A_UNKNOWN_AGENT`, `A2A_UNKNOWN_TASK`, or
  `A2A_NO_PEERS`.
- Not addressed: parent-to-delegate A2A, nested delegation, and any network
  A2A binding. Name reuse after deregister (a later `discussant` reading a
  stale task that still names `discussant`) is the same intra-session hazard
  as today.

## Alternatives considered

- **Keep same-session isolation:** rejected. The user-visible request is
  inter-session coordination, and the broker is already global; the deny was
  a leftover mailbox boundary, not a transport limit.
- **Address by `(name, contextId)` without uniquifying names:** rejected.
  Tasks persist `agentName` / `requesterName` as strings; two live `bob`
  agents would both pass membership checks. Uniquifying at register keeps
  that contract.
- **Qualify stored names as `name@contextId`:** rejected. It would leak
  session ids into every task summary the model reads, and would still need
  event filtering on the shared pipe.
