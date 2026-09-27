# Remote Agent Control Target Architecture

- Status: Target specification; post-MVP
- Decision: D373 / ADR 0205, amended by D376
- Scope: Remote observation and control of a PI-Desktop Agent Host
- Source of truth: `03-runtime/19-remote-agent-control-protocol.md`

## 1. Scope and status

This document specifies the target architecture for controlling a PI-Desktop
Agent from another client. It does not enable a network listener in the
current desktop release and does not change the frozen MVP boundary in
`00-baseline.md` or ADR 0004.

The target capability lets an authenticated client:

- discover and attach to sessions owned by an Agent Host;
- start, queue, observe, stop, and interrupt turns;
- receive ordered assistant, tool, approval, and lifecycle events;
- answer host-owned permission, contract approval, and input requests with
  the same decisions the desktop offers locally;
- reconnect after a transport failure without losing the session state; and
- use the same workspace, tool, secret, and permission boundaries as a local
  turn.

The feature is a control-plane API. It is not remote desktop streaming, an
arbitrary shell service, a provider proxy, or a replacement for the local
MCP control plane.

## 2. Design principles

1. **The Agent Host is the source of truth.** A client is a viewer and
   controller that may disconnect. A running turn is not owned by a browser
   tab or Electron window.
2. **The semantic contract is transport-neutral.** `RACP-WS` is the normative
   v1 binding. `RACP-HTTP` is the browser profile of the same contract.
   `RACP-GRPC` is reserved and is not part of v1 conformance. Every shipped
   binding exposes the same session, turn, event, approval, and attachment
   semantics.
3. **Local boundaries remain local.** Rust host-core continues to speak only
   stdio NDJSON JSON-RPC with its trusted Electron Main or standalone host
   supervisor. The Node pi sidecar continues to reach host services through
   the main-process proxy.
4. **The public edge is a capability boundary.** Remote clients never receive
   raw `host.proxy`, Electron IPC, host-core RPC, provider credentials, or an
   arbitrary operation catalog.
5. **State synchronization is explicit.** Every durable remote event has an
   `{ epoch, sequence }` cursor. Reconnect uses a cursor or a complete state
   snapshot; it never relies on wall-clock timestamps.
6. **Mutations are idempotent.** A lost response must not cause a second turn,
   duplicate approval, or repeated attachment mutation.
7. **A binding is replaceable.** A client may select a binding based on its
   capabilities without changing the Agent Host's behavior.
8. **The Host is headless.** Session and turn admission, the turn queue, the
   approval broker, the event log, and the snapshot builder live in a module
   with no Electron dependency. Desktop IPC, the local MCP control plane, and
   RACP are three callers of that one module.

## 3. Reference implementations and design inputs

The design takes patterns from, but does not adopt wholesale, the following
public projects:

- [OpenAI Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  uses JSON-RPC-shaped messages over stdio and WebSocket, separates threads,
  turns, and items, streams lifecycle notifications, and sends approval
  requests from the server to the client.
- [VS Code Agent Host](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/concepts/agent-host.md)
  puts the Agent in a dedicated host, keeps the host as the state source,
  supports remote JSON-RPC over WebSocket, and resynchronizes clients with
  snapshots and ordered actions.
- [MCP transports](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx)
  demonstrate JSON-RPC over local stdio and independent-process HTTP with
  optional server-sent events.
- [Google A2A](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
  separates a canonical data model and abstract operations from JSON-RPC,
  gRPC, and HTTP/JSON bindings.

PI-Desktop does not revive the withdrawn subagent A2A/Peer channel. ADR 0165
continues to govern subagent coordination.

## 4. Logical components

| Component | Responsibility | Must not own |
|---|---|---|
| Remote Client | Render state, send user intent, answer approvals and input requests | Workspace authority, provider credentials, final permission decisions, the prompt queue |
| Agent Host | Own sessions, turns, the per-session turn queue, event cursors, attachment records, tool execution, and lifecycle | Browser presentation state |
| Headless Agent Host module (`packages/agent-host`) | Own session/turn admission, the turn queue, the approval broker, the in-memory event log, and the snapshot builder; expose one typed API to desktop IPC, local MCP, and RACP | Electron, renderer, or transport dependencies; a second permission or persistence implementation |
| Gateway | Authenticate users, authorize routing, maintain Host links, rate-limit, audit, buffer attachment uploads transiently, and (reserved) push redacted approval and turn summaries | Provider secrets, durable transcript truth, arbitrary host-core access, attachment bytes beyond the upload window |
| Node pi sidecar | Run the pi Agent loop and provider streams | Remote authentication, workspace policy, secret storage |
| Rust host-core | Own SQLite, tools, workspace boundaries, permissions and the pending permission table, secrets, and durable local records | Public network listeners |

In the first phase the logical Agent Host is Electron Main hosting the
headless module beside its supervised sidecars. The production target moves
the same module and supervision into a standalone process group next to the
workspace. The external contract is the same in both deployments.

## 5. Deployment topologies

### 5.1 Current local desktop

This topology is unchanged:

```text
PI-Desktop
├── Electron Main
│   ├── Renderer
│   ├── Node pi sidecar
│   └── Rust host-core
└── local MCP control plane (optional, loopback-only)
```

The local MCP endpoint remains governed by ADR 0203. It is not a remote
Gateway and cannot be configured to bind a LAN or public interface.

### 5.2 Development or trusted LAN

```text
Remote Client ── WSS / SSH tunnel ── Agent Host
                                      ├── pi sidecar
                                      └── Rust host-core
```

Direct public exposure is not a supported production topology. A development
host may bind loopback and be reached through an authenticated SSH or device
tunnel. A trusted LAN deployment still requires TLS, authentication, and the
same authorization checks as a Gateway deployment.

### 5.3 Production Gateway

```text
Browser / Native Client ── HTTPS or WSS ── Remote Gateway
                                             │
                          outbound WSS Host  │
                          link (relay)       │
                                             ▼
                                      Agent Host
                                      ├── pi sidecar
                                      └── Rust host-core
```

The Agent Host opens the outbound connection. The Gateway does not require an
inbound port on the user's desktop and does not turn the host-core process into
a public service. The Host link is a relay profile
(`03-runtime/19-remote-agent-control-protocol.md` §11.4): it multiplexes
logical client connections so that server-initiated approval requests reach
the right client and attachment bytes reach the Host without an inbound port.
The Gateway keeps a short-lived route from a host identity to a live
connection and may queue control-plane metadata, but it does not queue
non-idempotent turn commands while the Agent Host is offline.

## 6. Ownership and authority

### 6.1 Agent Host ownership

The Agent Host is authoritative for:

- session and turn state, including the per-session turn queue;
- the current operating mode and permission mode, and the remote permission
  ceiling applied to remote-initiated turns;
- the workspace/project binding;
- epoch and sequence allocation and replay retention;
- approval and input request lifecycle, including requests raised before a
  client attached;
- attachment ownership and hash verification;
- tool execution and result classification; and
- crash, abort, and no-replay behavior.

The Gateway and Remote Client must treat host responses as authoritative. A
client-side optimistic state is display-only.

### 6.2 Client roles

An authenticated principal receives one or more scoped roles per session:

- `viewer`: read session metadata, history, and subscribe to events;
- `controller`: start or queue a turn, stop, interrupt, or cancel a turn,
  answer input requests, and upload input;
- `approver`: resolve tool and contract approvals allowed by policy; and
- `owner`: manage session membership, revoke clients, and archive a session.

Roles are additive but never bypass host policy. A `controller` cannot approve
its own request unless the policy explicitly grants the `approver` role.

Only one turn may run in a session. Multiple viewers are allowed. Queued
turns are Host state shared by every client, including the local desktop.
Concurrent mutations are serialized by the Agent Host and rejected with a
conflict when their expected session revision is stale. A turn started by a
remote principal runs under the Host's remote permission ceiling
(`03-runtime/19-remote-agent-control-protocol.md` §7.3).

### 6.3 Gateway ownership

The Gateway owns identity-to-host routing, not workspace state. It may store:

- host registration and connection health;
- user/session membership and revocation metadata;
- rate-limit counters;
- audit metadata;
- short-lived transport buffers, including attachment bytes only until the
  Host confirms the upload or it expires; and
- (reserved) push-notification registrations for redacted approval and turn
  summaries.

It must not persist provider API keys, raw tool arguments, raw tool results, or
full transcripts unless a separate product decision explicitly grants that
retention.

The Gateway's identity source is either an OIDC/OAuth 2.0 provider or the
first-party product account service; both satisfy
`05-security/02-remote-control-security.md` §3.1, and the choice is recorded
when rollout R3 starts.

## 7. Transport profiles

The protocol specification defines one abstract operation model and these
bindings:

| Profile | Intended client | Direction | Status |
|---|---|---|---|
| Local stdio JSON-RPC | Electron Main and sidecars | Full duplex | Existing; unchanged |
| `RACP-WS` JSON-RPC over WSS | Native clients, Electron, browser clients on the cookie profile | Full duplex | Normative v1 binding |
| `RACP-HTTP` HTTP/JSON + SSE | Browser and simple integrations | Commands plus server stream | Browser profile; required before a browser client ships |
| `RACP-GRPC` gRPC over TLS | Native service clients | Unary plus server stream | Reserved; not in v1 conformance |
| Host link `racp-hostlink.v1` | Gateway to Host | Multiplexed full duplex | Relay profile over `RACP-WS` framing |

The binding-neutral contract is specified in
`03-runtime/19-remote-agent-control-protocol.md`. A binding may be added only
when it preserves the same state transitions, error meaning, authorization
scope, event ordering, and cursor behavior, and it joins the conformance
fixture before it ships.

## 8. Session and event synchronization

Each session has a Host-generated `epoch` and, inside it, a monotonically
increasing `sequence` for durable events. The pair is never reused for that
session. Every event carries:

- `scope` (`session` or `host`);
- `sessionId` and optional `turnId`;
- `eventId`;
- `epoch`, plus `sequence` for durable events or `afterSequence` for
  ephemeral ones;
- `revision`;
- semantic `kind`;
- optional `parentToolCallId` and `agentName` for subagent rows; and
- a typed payload that carries the shared normalized `AgentEvent` for
  turn-scoped kinds.

Durable events are item and lifecycle boundaries, approvals, inputs, and
session changes. Ephemeral events are streaming deltas, tool progress, and
activity phases; they are delivered live, never sequenced, never replayed,
and never counted against the replay window. A snapshot's `activeItems`
carry what the deltas accumulated, so a reconnecting client loses nothing it
could not rebuild.

The first subscription response includes a snapshot and its `cursor`.
Subsequent durable events are ordered by `sequence`. A reconnect supplies
`after`:

```text
cursor in the current epoch and retained -> replay durable events with sequence > after
epoch changed or cursor evicted          -> resync.required + current snapshot
cursor ahead of the Host                 -> invalid cursor; client must refresh the snapshot
```

The first implementation keeps the durable log in Agent Host process memory;
a Host restart starts a new epoch and every client resynchronizes from a
snapshot. Rust host-core keeps exclusive SQLite ownership (frozen decision
12); persisting the log there would need its own ADR. The Gateway must not
renumber events. If the Gateway reconnects a Host link, each logical client
connection resumes from its last acknowledged cursor. A client may render
events optimistically, but it must drop duplicates, pause on a durable gap,
and apply a snapshot before continuing.

## 9. Turn and approval path

```text
Client -> initialize / attach / subscribe
Client -> turn/start (idempotency key, admission)
Host   -> accepted turn + cursor (turn.queued when queued)
Host   -> turn.started, ordered item events, ephemeral deltas
Host   -> approval/request or input/request (when policy requires a decision)
Client -> approval/respond | input/respond
Host   -> tool and item events
Host   -> turn.completed | turn.interrupted | turn.failed
Host   -> next queued turn starts
```

`turn/start` is an admission call. It returns quickly with a `turnId`; it must
not hold an HTTP request open until model execution ends. With
`admission: "queue"` the Host places the turn in its per-session queue and
releases it after the active turn's terminal event; the queue is Host state,
so the local desktop and every remote client see the same pending prompts.
The turn continues after the client disconnects. `turn/stop` is the graceful
stop at the next assistant/tool boundary; `turn/interrupt` is the immediate
abort; both are explicit and idempotent. A transport disconnect alone never
means stop or interrupt.

Permission, Plan, Goal, and input rules remain host-owned. A remote client
receives the same decision vocabulary the desktop offers: `allow-once`,
`allow-session`, and `deny` for tools; `approve` with an explicit permission
mode, or `reject`, for Plan and Goal contracts; and per-question answers or
skips for asktool prompts. A Plan or Goal approval is a session-level
transition that outlives the submitting turn. A remote client cannot change a
durable mode, select an unadvertised permission mode, or execute a tool
directly, and a remote-initiated turn never exceeds the Host's remote
permission ceiling. Approval lifetime is Host policy: the local default stays
120 seconds then deny, and a Host with remote control enabled may configure a
longer bounded lifetime because a remote approver is rarely at the keyboard.

## 10. Failure and recovery model

| Failure | Required behavior |
|---|---|
| Client disconnect | Keep the turn running; retain durable events within the replay window |
| Client reconnect | Authenticate again, attach, replay from cursor or return snapshot |
| Gateway disconnect | Agent Host retries the Host link with bounded exponential backoff; local turns continue |
| Agent Host unavailable | Gateway rejects new mutations with `AGENT_UNAVAILABLE`; it does not replay them automatically |
| Agent Host restart | New epoch; clients resync from a snapshot; queued turns are gone and the snapshot shows an empty queue; nothing is replayed |
| Agent Host crash | Existing host recovery rules apply; interrupted work is never replayed automatically |
| Duplicate mutation | Return the original idempotent result for the same principal and key |
| Durable event gap | Stop applying events and request a snapshot; never guess intermediate state |
| Slow client | Drop ephemeral events first; disconnect with a resumable cursor before losing a durable event |
| Expired approval | Return `APPROVAL_EXPIRED`; do not execute the tool |

## 11. Migration boundary

The first implementation delivers the headless Agent Host module
(`packages/agent-host`). It owns session and turn admission, the per-session
turn queue, the approval broker, the in-memory event log with epochs, and the
snapshot builder, and it has no Electron dependency. Electron Main hosts the
module and its IPC handlers become adapters over it; that move may be
incremental, with the module first wrapping the existing handlers and then
absorbing them. The RACP server binds to the module, never to renderer IPC,
`host.proxy`, or Rust host-core RPC from a network listener. The local MCP
control plane (ADR 0203) is unchanged now and may later move onto the same
module.

Two local changes accompany the module: Rust host-core exposes the pending
permission table through a `permissions.pending` read so late-attaching
clients receive open requests, and the renderer's in-memory prompt queue is
replaced by the Host-owned turn queue before more than one client can control
a session.

The standalone Agent Host extraction moves the module and supervision into a
new process without changing the wire contract. The migration is complete
when the local desktop, a standalone host, and a Gateway route expose the same
session/turn/event behavior.

## 12. Acceptance criteria

1. A remote client can attach to a session without taking ownership of its
   workspace path or secrets.
2. A turn continues after the initiating client disconnects.
3. A second client can observe the same turn and receive the same ordered
   durable events.
4. Reconnection either replays every durable event after the supplied cursor
   or returns a complete snapshot with an explicit resync reason; streaming
   deltas are recovered from the snapshot's active items.
5. Every mutation is idempotent and scoped to an authenticated principal.
6. Permission, contract, and input requests can be answered remotely with the
   full local decision vocabulary without bypassing host policy, and a client
   that attaches late sees requests raised before it attached.
7. Rust host-core remains unreachable from the network.
8. Every shipped binding produces equivalent domain results for the same
   command sequence.
9. The current local stdio JSON-RPC and loopback MCP paths remain unchanged.
10. A remote-initiated turn never runs above the Host's remote permission
    ceiling.
11. The headless Agent Host module runs its test suite without Electron, and
    desktop IPC, local MCP, and RACP call the same module.

## 13. Amendment history

D376 (2026-09-10) amended the D373 target before implementation: one
normative v1 binding with a browser profile and a reserved gRPC binding, the
headless Agent Host module as the first deliverable, the Host-owned turn
queue, `{ epoch, sequence }` cursors with ephemeral deltas, the full local
approval vocabulary, the Host link relay profile, the remote permission
ceiling, and the remote approval lifetime policy.
