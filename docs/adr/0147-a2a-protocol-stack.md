# ADR 0147: A2A Protocol Stack for Subagent Coordination

- Status: Superseded by ADR 0165
- Date: 2026-09-02
- Deciders: PI-Desktop core
- Related: D277, D318, D321, ADR 0062, ADR 0089, ADR 0100, ADR 0162, ADR 0164,
  `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, E2E-165, E2E-165b, E2E-165c, E2E-165d
- Supersedes: ADR 0138 and ADR 0140. The in-process `SubagentMailbox` and the
  single `Peer` tool are removed. The coordination need those ADRs identified
  is preserved; the mechanism is replaced.
- Amended by: ADR 0162 lifts same-context-only addressing. ADR 0164 lets the
  parent agent register as `kind: "parent"` and call `A2A` to other parents;
  parents still cannot address subagents.

## Context

ADR 0138 introduced a session-scoped `SubagentMailbox` and delegate-only peer
tools; ADR 0140 folded them into one `Peer` tool with `send | inbox | wait`
actions. Both kept coordination entirely in-process in the Node agent-runtime
sidecar: messages never reached host-core, carried no durable state, and had no
task lifecycle, discovery, or authorization model beyond a runtime-supplied
sender name.

That mechanism worked for bounded text between siblings but was a private
protocol that could not grow. It had no task state machine (a message was
fire-and-forget), no durable history a delegate could re-read after a restart,
no typed payloads beyond text, no discovery surface a delegate could query, and
no capability model — only the fact that the sidecar injected `from`. It also
diverged from the industry Agent2Agent (A2A) protocol, so nothing PI-Desktop
built could interoperate with, or be reasoned about against, that contract.

## Decision

Replace peer messaging with a real **A2A (Agent2Agent) protocol stack** whose
broker lives in the Rust host-core process. Each subagent in the agent-runtime
sidecar is an A2A **client** that reaches the broker over the existing stdio
JSON-RPC 2.0 / NDJSON transport — the same pipe the `plans.*` domain uses —
through a new `a2a.*` method domain. There is no HTTP, gRPC, or REST server and
no network OAuth stack; the entire A2A surface is bound to the local transport.

The seven A2A pillars map to local semantics:

| A2A pillar | Standard form | Local mapping |
|---|---|---|
| Transport | HTTP + JSON-RPC / SSE | Existing stdio NDJSON JSON-RPC 2.0, new `a2a.*` method domain |
| Agent Card discovery | `GET /.well-known/agent-card.json` | Broker holds an in-memory agent registry; `a2a.agents.list` returns cards derived from each `SubagentDefinition` (name/description/skills) |
| Task state machine | Server-managed task lifecycle | Durable SQLite `a2a_tasks` rows in host-core: `submitted, working, input-required, auth-required, completed, canceled, failed, rejected`; the last four are terminal and never transition again; the broker enforces legal transitions and `a2a.tasks.status` drives a task to a new state. Each task records both `agentName` (the worker that serves it) and `requesterName` (the peer that sent the first message) |
| Message / Parts | Typed `Part` union | `TextPart{kind:"text",text}` \| `FilePart{kind:"file",file:{name?,mimeType?,uri?,bytes?}}` \| `DataPart{kind:"data",data}`, mirrored in TS (`packages/shared/src/a2a.ts`) and Rust (`crates/host-core/src/a2a/types.rs`) |
| Streaming | `message/stream` over SSE | Host→client JSON-RPC notification `a2a.task.event` carrying a `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`, shaped `{ recipient, contextId, event }`; routing is **counterpart-based** — a status/terminal event routes to the counterpart of whoever caused it (a worker's reply or completion wakes the requester; a requester's follow-up wakes the worker), so an agent waits for events addressed to itself |
| Push notification | Webhook config | Host-owned push config (`a2a.tasks.pushNotificationConfig.set/get`) plus an `a2a.push` notification `{ recipient, contextId, taskId, token?, status }` |
| Auth | OAuth / API key | Host-minted per-agent capability token: `a2a.agents.register` returns `{ agentId, token }`, every subsequent `a2a.*` call carries the token, and the host validates it and authorizes addressing by it. The token is injected by the runtime and never visible to the model, preserving the invariant that a sender's `from` cannot be forged |

`contextId` equals the `sessionId` and groups a task with the requester's
session. Discovery and addressing span every live agent on the host (ADR 0162);
a stranger still cannot read a task they are not a party to.

The `a2a.*` methods, each carrying a `token` except `register`, are specified in
`03-runtime/06-host-rpc-protocol.md` §4; `a2a.tasks.status({ token, id, state,
message? })` drives a task to a new state (completion / failure / interactive
pause), validating the transition against the state table and stamping any
optional `message` with broker-owned `from`/`contextId`. On the runtime side,
the single subagent-facing tool is `A2A` (replacing `Peer`) with actions
`discover | send | get | wait | complete | cancel`; `complete` finishes a task
the delegate serves and wakes its requester.

Event routing is **counterpart-based**. Task creation addresses the new task to
the worker; `a2a.message.send` on an existing task, `a2a.tasks.status`, and
`a2a.tasks.cancel` route the `a2a.task.event` (and, for a terminal state with a
push config, the `a2a.push`) to the counterpart of the caller — a worker's reply
or completion wakes the requester, a requester's follow-up wakes the worker;
`a2a.tasks.resubscribe` re-emits to the caller itself. This closes the
delegation round-trip a worker's completion previously never reached the
requester. The delegate `A2A` tool is registered/deregistered per
delegation on spawn/settle and closes over the host-minted token.
`SUBAGENT_A2A_TOOLS = ["A2A"]` replaces `SUBAGENT_PEER_TOOLS = ["Peer"]`.
ADR 0164 additionally registers the parent as `kind: "parent"` and puts
`A2A` in the Agent-mode catalog for parent-to-parent use only.

Bounds are enforced by the broker: `A2A_MAX_TEXT_CHARS = 16000`,
`A2A_MAX_FILE_BYTES = 20MB`, `A2A_MAX_TASK_HISTORY = 256`,
`A2A_MAX_TASKS_PER_CONTEXT = 128`, `A2A_MAX_SENDS_PER_RUN = 200`,
`A2A_MAX_STREAM_WAIT_SECONDS = 120`, `A2A_DEFAULT_STREAM_WAIT_SECONDS = 30`.
Errors use JSON-RPC numeric code `1400` with `data.errorCode` one of
`A2A_UNKNOWN_TOKEN`, `A2A_UNKNOWN_AGENT`, `A2A_UNKNOWN_TASK`,
`A2A_CROSS_CONTEXT_DENIED`, `A2A_INVALID_TRANSITION`, `A2A_TASK_TERMINAL`,
`A2A_SEND_CAP`, `A2A_NO_PEERS`, `A2A_PAYLOAD_TOO_LARGE`.

## Non-goals

- **No gRPC, HTTP, or REST binding.** The only transport binding is the local
  stdio JSON-RPC pipe. The `/.well-known/agent-card.json` discovery endpoint
  and the SSE / webhook transports are mapped onto local RPC, not served.
- **No real OAuth.** Authorization is a host-minted in-memory capability token,
  not a network OAuth or API-key exchange.
- **No cross-machine or remote agents.** Every agent is a subagent of a local
  session on this host; there is no agent outside the host process. Cross-session
  addressing on the same host is allowed (ADR 0162).

## Consequences

- **Protocol v10 and schema v12 are breaking.** `PROTOCOL_VERSION` moves from 9
  to 10 and the `app.handshake` capabilities array now includes `"a2a"`; an old
  host that cannot advertise `a2a` is rejected at handshake before the UI
  becomes interactive. `SCHEMA_VERSION` moves from 11 to 12: `migrate_v11_to_v12`
  adds `a2a_agents`, `a2a_tasks`, `a2a_messages`, `a2a_artifacts`, and
  `a2a_push_configs`. The `a2a_messages` primary key is composite
  `(task_id, message_id)` so client-supplied message ids cannot collide across
  tasks, and each mutating call (task creation, existing-task send, status
  update) persists its multiple writes in a single SQLite transaction.
  Capability tokens are in-memory only and are invalidated on deregister.
- Coordination is now durable and inspectable: a task and its message history
  survive in SQLite, so a delegate can re-read a task with `a2a.tasks.get` and
  the lifecycle is auditable, unlike the destructive-drain mailbox.
- Payloads are typed (`TextPart`/`FilePart`/`DataPart`) rather than text-only,
  so delegates can exchange files and structured data within the bounds above.
- The forged-sender invariant is preserved by construction: the capability token
  is injected by the runtime and never exposed to the model, so a delegate can
  neither spoof another agent nor address a task it does not own.
- Boundaries from the superseded ADRs still hold: the `A2A` tool never enters
  the parent's `toolCatalog`; a settled delegate is deregistered, invalidating
  its token; and the stream wait ceiling (120s) stays below the 300-second idle
  watchdog.
- Not addressed: messaging with the parent, nested delegation, and any remote
  or cross-machine transport. Cross-session addressing is decided in ADR 0162.

## Alternatives considered

- **Keep the in-process mailbox (ADR 0138/0140):** rejected. It cannot carry a
  task lifecycle, durable history, typed payloads, discovery, or a real
  authorization model, and it is a private contract no other component can reason
  about.
- **Run a real A2A HTTP/SSE server in host-core:** rejected. It adds a network
  listener, an OAuth stack, and a cross-machine surface for a purely local,
  same-session coordination need. Binding the A2A semantics onto the existing
  JSON-RPC pipe gives the protocol shape with none of that attack surface.
- **Put the broker in the sidecar rather than host-core:** rejected. Durable
  task state, migrations, and capability-token authority belong with the process
  that already owns SQLite and the security boundary; a sidecar-owned broker
  would duplicate persistence and could not survive a sidecar restart.
