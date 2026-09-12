# 19. Remote Agent Control Protocol

- Protocol name: `PI Remote Agent Control Protocol` (`RACP`)
- Version: `1.0`
- Status: Target specification; post-MVP
- Decision: D373 / ADR 0205, amended by D374 and D375
- Transport profiles: `RACP-WS` (normative v1 binding; first deployed over an
  SSH tunnel), `RACP-HTTP` (browser profile; unscheduled), `RACP-GRPC`
  (reserved)

This document is normative for the remote control contract. It defines the
operation model once and maps it to transports. It does not change the
existing Electron IPC, sidecar JSON-RPC, Rust host-core RPC, or local MCP
protocols.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are to be interpreted as requirements for a future implementation.

## 1. Contract boundaries

RACP controls a running Agent Host. It is not:

- a public version of Electron IPC;
- a public version of `host.proxy`;
- a host-core network protocol;
- a provider or model API proxy;
- an arbitrary command/shell API;
- the local MCP control plane; or
- the withdrawn subagent A2A/Peer protocol.

The Agent Host remains responsible for authentication context, authorization,
workspace selection, tool policy, permission decisions, persistence, and
provider credentials. A RACP server MUST route a request through those same
authorities rather than reproducing them in a Gateway or client.

RACP v1 is a strict subset of what the local desktop can do. The remote-host
profile in §6.2 is the v1.1 addition that lets the desktop itself act as the
Remote Client of a `pi-host` on another machine (D375); operations that stay
deferred are listed in §6.3 so that no binding invents them under another
name.

## 2. Terminology

| Term | Meaning |
|---|---|
| Host | The logical Agent Host that owns sessions and executes turns |
| Client | A UI, CLI, native application, or service controlling a Host |
| Gateway | An optional authenticated router between Clients and Hosts |
| Session | A durable conversation and workspace/project binding |
| Turn | One admitted prompt and its whole model/tool lifecycle; it equals the local `turnId` returned by `agent/prompt`, not one local `turn_start`/`turn_end` model round |
| Item | A durable unit inside a Turn: a message, a tool call, or a compaction checkpoint |
| Event | An ordered state or progress notification for a Session or a Host |
| Durable event | An event that receives a sequence number and is retained for replay |
| Ephemeral event | A progress event that is delivered live, never sequenced, and never replayed |
| Epoch | A Host-generated identifier for one continuous sequence stream of a Session |
| Cursor | An `{ epoch, sequence }` position inside a Session's durable event stream |
| Principal | The authenticated user, device, service, or Gateway identity |
| Binding | A transport-specific encoding of the RACP operations |
| Host link | The outbound Gateway-to-Host connection that relays logical client connections |

## 3. Version and initialization

Every remote connection MUST begin with `connection/initialize`. No other
request, notification, or server request is valid before the initialization
response and the client's `notifications/initialized` notification.

The client sends:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "connection/initialize",
  "params": {
    "protocolVersion": "1.0",
    "client": {
      "name": "pi-desktop-web",
      "version": "0.1.0"
    },
    "bindings": ["RACP-WS", "RACP-HTTP"],
    "capabilities": {
      "eventReplay": true,
      "approvals": true,
      "inputRequests": true,
      "attachments": true,
      "turnQueue": true,
      "hostEvents": true,
      "history": true,
      "toolRelay": true,
      "terminal": true
    },
    "maxReceiveBytes": 1048576
  }
}
```

The Host returns:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "result": {
    "protocolVersion": "1.0",
    "server": {
      "name": "pi-desktop-agent-host",
      "version": "0.1.0"
    },
    "connectionId": "conn_01J...",
    "principal": {
      "subject": "user_123",
      "roles": ["viewer", "controller"]
    },
    "capabilities": {
      "eventReplay": true,
      "snapshot": true,
      "approvals": true,
      "inputRequests": true,
      "attachments": true,
      "serverRequests": true,
      "turnQueue": true,
      "hostEvents": true,
      "history": true,
      "remoteHostProfile": true,
      "toolRelay": true,
      "terminal": true,
      "notifications": false,
      "bindings": ["RACP-WS"]
    },
    "limits": {
      "maxFrameBytes": 1048576,
      "maxPromptBytes": 262144,
      "maxAttachmentBytes": 52428800,
      "maxSubscriptionsPerConnection": 8,
      "maxQueuedTurnsPerSession": 8,
      "replayWindowEvents": 10000
    },
    "policy": {
      "remoteMaxPermissionMode": "ask",
      "applyCeilingToPairedDevices": false,
      "approvalLifetimeMs": 1800000
    }
  }
}
```

The Host MUST reject unsupported major versions with `PROTOCOL_MISMATCH`.
Minor-version additions are compatible when the client can ignore unknown
fields and the Host does not require an unadvertised capability.

`policy` is informational. It tells a client which permission ceiling applies
to turns it starts (§7.3) and how long an approval stays answerable (§12). A
client cannot change either value through RACP.

## 4. Message envelopes

### 4.1 JSON-RPC profiles

`RACP-WS` uses JSON-RPC 2.0 messages. Each WebSocket text frame contains one
complete UTF-8 JSON-RPC message. Binary frames are rejected on client
connections. JSON-RPC batch requests are not supported.

`RACP-HTTP` maps each operation to one HTTP request with an equivalent JSON
operation body; it does not require a JSON-RPC envelope. Responses are JSON
domain objects. The request context is carried in the operation body and, where
available, the equivalent `X-Request-Id`, `Idempotency-Key`, and
`If-Match-Revision` headers. Event streaming uses `text/event-stream`; each
SSE `data` field contains one `EventEnvelope` JSON object, not a JSON-RPC
notification.

Requests that mutate state MUST include an application-level
`idempotencyKey`, stable for the lifetime of a retry. JSON-RPC `id` identifies
the transport request; it is not the idempotency key.

### 4.2 Common request fields

```ts
type RequestContext = {
  requestId: string
  idempotencyKey?: string
  expectedRevision?: number
  traceparent?: string
}
```

The binding maps `RequestContext` into the JSON-RPC `params.context` object,
HTTP headers, or transport metadata. A Gateway MUST preserve the context values
and MUST NOT replace an idempotency key while retrying a request.

### 4.3 Server notifications and requests

The WebSocket binding MAY send server notifications and server-initiated
requests. A server request has its own JSON-RPC id and MUST receive a response
on the same logical client connection (§11.4 defines how a Gateway relays that
connection).

The HTTP/SSE binding cannot require a client to answer a server-initiated JSON-
RPC request. It represents approval and input requests as events and requires
the client to call the corresponding `approval/respond` or `input/respond`
HTTP endpoint.

## 5. Canonical resources

The following shapes define the semantic model. They are authored as typebox
schemas in `packages/shared` (frozen decision 28); the JSON Schema fixtures and
any future Protobuf file are generated from that source (§14). Every binding
MUST preserve field meaning and state transitions.

### 5.1 Session

```ts
type Session = {
  id: string
  title: string
  projectId?: string
  workspaceLabel?: string
  mode: "agent" | "plan" | "goal"
  status: "idle" | "running" | "waiting_permission" | "aborted" | "error"
  planningState: "inactive" | "planning" | "awaiting_approval"
  permissionMode: "ask" | "accept-edits" | "auto"
  activeTurnId?: string
  queuedTurnIds: string[]
  revision: number
  createdAt: string
  updatedAt: string
}
```

`status` and `planningState` mirror the local session state machine
(`10-session-state-machine.md` §0–§1): `planningState` is the Plan/Goal
projection and `awaiting_approval` means a pending contract approval exists
even though no turn is running. An absolute workspace path MUST NOT be
included unless the principal has an explicit path-disclosure scope. A
`workspaceLabel` is display-only.

### 5.2 Turn

```ts
type Turn = {
  id: string
  sessionId: string
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "completed"
    | "interrupted"
    | "failed"
    | "canceled"
  admission: "reject_if_busy" | "queue"
  queuePosition?: number
  effectivePermissionMode: "ask" | "accept-edits" | "auto"
  idempotencyKey?: string
  startedAt?: string
  endedAt?: string
  error?: RemoteError
}
```

Only one turn per session may be `running`, `waiting_approval`, or
`waiting_input`. Up to `maxQueuedTurnsPerSession` turns may be `queued`; the
Host releases them first-in first-out after the active turn's terminal event.
Queued turns and their idempotency keys are persisted by Rust host-core
(D375), so a Host restart restores the queue in order. A restored queue is
held; release resumes on the first controller attach, local or remote, so a
reboot never starts work unattended.
`canceled` is the terminal state of a queued turn that never started;
`interrupted` is the terminal state of a started turn that was stopped or
aborted. Terminal turns are immutable.

`effectivePermissionMode` is the mode the Host actually applied to the turn
after the remote permission ceiling in §7.3. It never changes the durable
`Session.permissionMode`.

### 5.3 Event envelope

```ts
type EventEnvelope = {
  eventId: string
  scope: "session" | "host"
  sessionId?: string
  turnId?: string
  epoch: string
  sequence?: number
  afterSequence?: number
  revision: number
  kind: EventKind
  occurredAt: string
  parentToolCallId?: string
  agentName?: string
  payload: unknown
}

type EventKind =
  | "session.created"
  | "session.changed"
  | "session.archived"
  | "host.changed"
  | "turn.queued"
  | "turn.started"
  | "turn.completed"
  | "turn.interrupted"
  | "turn.failed"
  | "turn.canceled"
  | "turn.activity"
  | "item.started"
  | "item.delta"
  | "item.completed"
  | "tool.progress"
  | "terminal.changed"
  | "terminal.output"
  | "approval.requested"
  | "approval.resolved"
  | "input.requested"
  | "input.resolved"
  | "resync.required"
```

Durable events carry `sequence`. Ephemeral events (`turn.activity`,
`item.delta`, `tool.progress`, `terminal.output`) carry `afterSequence`
instead: the sequence of the last durable event they follow. Ephemeral events are never retained,
never replayed, and never counted against the replay window; the snapshot's
`activeItems` carry the content they accumulated (§5.4). A client applies gap
detection to `sequence` only.

`sequence` is allocated by the Host, starts at `1` for a new epoch, is
strictly increasing inside that epoch, and is never derived from
`occurredAt`. A new `epoch` starts whenever the Host cannot prove continuity,
for example after a Host process restart; the pair `(epoch, sequence)` is
therefore never reused for a Session. A Gateway MUST forward both unchanged.

`parentToolCallId` and `agentName` are set on every event emitted inside a
subagent, exactly as on the local `AgentEventEnvelope` (ADR 0062), so a remote
transcript can nest delegate rows the same way the desktop does.

Turn-scoped kinds carry the shared normalized `AgentEvent` unchanged under
`payload.event`, plus `payload.itemType` for item kinds, so a remote client can
reuse the desktop transcript reducer instead of implementing a second one. The
mapping is fixed:

| Local `AgentEvent.type` | RACP `kind` | Durable | Notes |
|---|---|---|---|
| `agent_start` | `turn.started` | yes | `turn.queued` precedes it for queued admissions |
| `agent_end` | `turn.completed` or `turn.interrupted` | yes | `interrupted` when the Host recorded the turn as aborted or stopped |
| `error` (terminal) | `turn.failed` | yes | Carries the normalized `AppError` |
| `turn_start`, `turn_end`, `status` | `turn.activity` | no | Model rounds and activity phases such as `waiting-model`, `compacting`, `waiting-subagents` |
| `message_start` | `item.started` | yes | `itemType: "message"` |
| `message_update` | `item.delta` | no | Delta text and thinking; content is complete in `item.completed` |
| `message_end` | `item.completed` | yes | Full `UiMessage` |
| `tool_start` | `item.started` | yes | `itemType: "tool"` |
| `tool_update` | `tool.progress` | no | Partial results are complete in `item.completed` |
| `tool_end` | `item.completed` | yes | Full result with `isError` and usage |
| `compaction_start`, `compaction_end` | `item.started`, `item.completed` | yes | `itemType: "compaction"`; compaction adds a transcript row locally (D203) |
| `planning_state`, host `plans.changed` | `session.changed` | yes | Planning projection and contract approval state |
| `tool_permission_request` | `approval.requested` | yes | `kind: "tool"` |
| host `plans.changed` with a `pending` proposal | `approval.requested` | yes | `kind: "plan"` or `"goal"`; resolution arrives as `approval.resolved` plus `session.changed` |
| `asktool_request` | `input.requested` | yes | Same questions as the local asktool card |

`turn.completed` therefore maps to the local `agent_end`, never to the local
`turn_end`, which only closes one model round (`01-ipc-protocol.md` §6).

`terminal.changed` (durable) records a terminal opening, closing, or exiting.
`terminal.output` (ephemeral) carries pty bytes; it is recoverable only from
the terminal's bounded replay ring (§6.2), never from the event log.

An event payload that would exceed `maxFrameBytes` is emitted with
`payload.truncated: true` and a bounded preview; the complete item is
retrievable through `session/history` by `itemId`. Events are never dropped
to satisfy the frame limit.

### 5.4 Snapshot

```ts
type ItemSummary = {
  id: string
  turnId: string
  itemType: "message" | "tool" | "compaction"
  status: "streaming" | "completed"
  sequence?: number
  createdAt: string
  parentToolCallId?: string
  agentName?: string
  content: unknown
}

type SessionSnapshot = {
  session: Session
  activeTurn?: Turn
  queuedTurns: Turn[]
  items: ItemSummary[]
  activeItems: ItemSummary[]
  pendingApprovals: ApprovalRequest[]
  pendingInputs: InputRequest[]
  hasMoreHistory: boolean
  cursor: { epoch: string; sequence: number }
  revision: number
  generatedAt: string
}
```

`items` is the newest bounded page of completed items; older pages come from
`session/history`. `activeItems` are the in-flight message and tool items with
the content accumulated so far, which is why ephemeral deltas need no replay;
the Host builds them from the same in-flight state that feeds the local
inflight checkpoint (D299). `pendingApprovals` and `pendingInputs` let a
late-attaching client render open requests that were raised before it
subscribed. A snapshot is valid only together with its `cursor` and
`revision`.

### 5.5 Approval and input request

Approval decisions are a superset of the local vocabulary, never a
simplification of it. A tool approval offers the local
`ToolPermissionResolution` decisions; a Plan or Goal approval offers the local
`plans.resolve` actions plus the explicit permission-mode selection the
desktop requires (`10-session-state-machine.md` §3.13).

```ts
type ToolApprovalDecision = "allow-once" | "allow-session" | "deny"
type ContractApprovalDecision = "approve" | "reject"

type ApprovalRequest = {
  id: string
  sessionId: string
  turnId: string
  kind: "tool" | "plan" | "goal"
  summary: string
  expiresAt: string
  revision: number
  toolName?: string
  risk?: "low" | "medium" | "high"
  agentName?: string
  parentToolCallId?: string
  title?: string
  question?: string
  artifact?: { relativePath: string; sha256: string; sizeBytes: number }
  allowedDecisions: ToolApprovalDecision[] | ContractApprovalDecision[]
  allowedPermissionModes?: Array<"ask" | "accept-edits" | "auto">
}

type ApprovalResponse = {
  approvalId: string
  decision: ToolApprovalDecision | ContractApprovalDecision
  permissionMode?: "ask" | "accept-edits" | "auto"
  context: RequestContext
}

type InputRequest = {
  id: string
  sessionId: string
  turnId: string
  expiresAt: string
  agentName?: string
  parentToolCallId?: string
  questions: Array<{
    id: string
    question: string
    options: string[]
    multiSelect: boolean
  }>
}

type InputResponse = {
  inputId: string
  answers: Array<string[] | null>
  context: RequestContext
}
```

Rules:

1. `allow-session` grants the tool by name for the rest of the Session
   (frozen decision 18). The Host offers it to a remote approver only when its
   policy allows session grants from remote principals; otherwise
   `allowedDecisions` omits it.
2. A Plan or Goal approval is a session-level transition, not an in-turn wait.
   `turnId` identifies the submitting turn, the request outlives that turn,
   `Session.planningState` is `awaiting_approval` while it is pending, and a
   Host restart interrupts it without replay. `approve` requires
   `permissionMode` from `allowedPermissionModes`; the desktop default is
   `ask`.
3. An `InputResponse` answer of `null` means the question was skipped; the
   whole array may be `null` entries when the user declined the prompt, which
   is the local `AskToolResolution` contract.
4. Approval summaries MUST be safe to display. Raw provider credentials,
   secret values, and unbounded tool results are never included.
5. Expiry maps the local `PERMISSION_TIMEOUT` and `PLAN_APPROVAL_TIMEOUT`
   outcomes to `APPROVAL_EXPIRED`; the tool is never executed after expiry.

### 5.6 Attachment

```ts
type Attachment = {
  id: string
  sessionId: string
  name: string
  mimeType: string
  sizeBytes: number
  sha256: string
  status: "pending" | "ready" | "expired" | "rejected"
  expiresAt: string
}
```

Remote turns reference attachment ids. They MUST NOT send a local absolute path
and MUST NOT make a remote client path visible to host tools.

### 5.7 Host and project summaries

```ts
type HostSummary = {
  id: string
  label: string
  status: "online" | "offline"
  lastSeenAt: string
  protocolVersion: string
}

type ProjectSummary = {
  id: string
  label: string
  archived: boolean
}
```

`HostSummary` exists only behind a Gateway, which is the only place a principal
has more than one Host. `ProjectSummary` never contains an absolute path unless
the principal has the path-disclosure scope.

## 6. Operation catalog

### 6.1 v1 operations

All operation names are lower-case, singular-resource paths. Every binding maps
to this same catalog.

| Operation | Role | Behavior |
|---|---|---|
| `connection/initialize` | authenticated | Negotiate protocol, capabilities, limits, and policy |
| `connection/ping` | authenticated | Return connection health and server time |
| `host/list` | authenticated | List Hosts visible to the principal; Gateway deployments only |
| `project/list` | viewer | List projects the principal may create sessions under |
| `session/list` | viewer | List sessions visible to the principal |
| `session/get` | viewer | Return metadata and current state |
| `session/create` | controller | Create a session under an authorized project id |
| `session/attach` | viewer | Establish a session role and return a snapshot |
| `session/history` | viewer | Page older completed items backwards from an item id |
| `events/subscribe` | viewer | Subscribe to a session or host stream from a cursor |
| `events/unsubscribe` | viewer | Remove a subscription |
| `events/ack` | viewer | Acknowledge the highest applied durable sequence |
| `turn/start` | controller | Admit a turn immediately or into the Host queue; return `turnId` |
| `turn/get` | viewer | Return the current turn state |
| `turn/stop` | controller | Finish the current assistant/tool boundary, then end the turn; idempotent |
| `turn/interrupt` | controller | Abort the turn now; cancels a queued turn; idempotent |
| `turn/cancel` | controller | Remove a queued turn that has not started; idempotent |
| `turn/prioritize` | controller | Move a queued turn to the head of its session's queue; idempotent |
| `approval/respond` | approver | Resolve one live approval request |
| `input/respond` | controller | Resolve one live input request |
| `attachment/create` | controller | Reserve a bounded attachment slot |
| `attachment/complete` | controller | Verify an uploaded attachment hash and size |
| `tools/advertise` | owner | Advertise client-executed tools for a session; replaces the connection's previous set; cleared on disconnect |
| `session/revoke` | owner | Revoke a client or session membership |
| `session/archive` | owner | Archive an idle session |

The server MUST reject unknown operations with `METHOD_NOT_FOUND`. A client
MUST use capability discovery rather than assuming optional operations exist.

### 6.2 Remote-host profile (v1.1, required by rollout R2)

When the desktop is the Remote Client of a `pi-host` on another machine, the
renderer expects the session controls it has locally. These operations are
part of the contract from v1.1 and are advertised through the
`remoteHostProfile` capability. Each one keeps its local rule: configuration
and fork are idle-only, deletion is owner-only, and every workspace read is
resolved against the Session's durable root with the Host's ignore rules and
`PATH_OUTSIDE_WORKSPACE` boundary. Terminals run on the Host machine with the
session root as working directory and stream through `terminal.output`.

| Operation | Role | Behavior |
|---|---|---|
| `session/configure` | controller | Change mode, provider/model, thinking level, or permission mode while idle; same rules as `pi-desktop/session/configure` |
| `session/fork` | controller | Fork an idle session, optionally through a message id, into a new idle session |
| `session/rename` | controller | Rename a session |
| `session/delete` | owner | Delete a session and its transcript on the Host |
| `session/compact` | controller | Run a manual context checkpoint on the active session |
| `workspace/list` | viewer | List entries under the session root, bounded, honoring the Host ignore rules |
| `workspace/read` | viewer | Read one bounded file under the session root; images as data URLs |
| `workspace/diff` | viewer | Return the working-tree diff of the session root |
| `terminal/open` | controller | Open a pty on the Host with the session root as cwd; returns a terminal id and the bounded replay ring; policy-gated (security §4.1) |
| `terminal/input` | controller | Write bytes to an open terminal |
| `terminal/resize` | controller | Resize an open terminal |
| `terminal/close` | controller | Close a terminal; idempotent |

### 6.3 Deferred operations

The desktop offers these locally. RACP does not expose them yet; the names
are reserved so a later minor version adds them under the same catalog and
no binding invents a substitute.

| Reserved operation | Local equivalent | Why deferred |
|---|---|---|
| per-turn model or thinking override | composer next-turn configuration | `session/configure` covers the idle case; per-turn overrides need their own policy review |
| provider, secret, and vendor account management | settings and secrets IPC | Explicitly out of scope; remote Host providers are configured over the SSH bootstrap channel |

## 7. Core operation shapes

### 7.1 `session/attach`

Request:

```json
{
  "sessionId": "ses_01J...",
  "role": "controller",
  "after": { "epoch": "ep_7f", "sequence": 314 },
  "includeSnapshot": true,
  "context": {
    "requestId": "req_attach_1"
  }
}
```

Response:

```json
{
  "session": { "id": "ses_01J...", "status": "idle", "revision": 22 },
  "role": "controller",
  "replayComplete": true,
  "snapshot": {
    "cursor": { "epoch": "ep_7f", "sequence": 314 },
    "revision": 22,
    "items": [],
    "activeItems": [],
    "queuedTurns": [],
    "pendingApprovals": [],
    "pendingInputs": [],
    "hasMoreHistory": true
  }
}
```

If `after` names an epoch the Host no longer serves, or a sequence older than
the retained window, the response MUST set `replayComplete` to `false` and
include a current snapshot. The client MUST NOT present the result as a
continuous replay.

### 7.2 `events/subscribe`

Request:

```json
{
  "scope": "session",
  "sessionId": "ses_01J...",
  "after": { "epoch": "ep_7f", "sequence": 314 },
  "includeSnapshot": false,
  "context": { "requestId": "req_events_1" }
}
```

Response:

```json
{
  "subscriptionId": "sub_01J...",
  "scope": "session",
  "sessionId": "ses_01J...",
  "starting": { "epoch": "ep_7f", "sequence": 315 },
  "replayComplete": true
}
```

`scope: "host"` omits `sessionId` and subscribes to `session.created`,
`session.changed`, `session.archived`, and `host.changed` for every session
the principal may see, with its own epoch and sequence stream. Without a host
subscription a client never learns about sessions the local user creates.

The WebSocket server then sends `session/event` notifications. The HTTP server
returns an SSE stream whose `id` is `"<epoch>:<sequence>"` and whose `data` is
the `EventEnvelope`. A client MUST treat an SSE `Last-Event-ID` as `after` on
reconnect.

### 7.3 `turn/start`

Request:

```json
{
  "sessionId": "ses_01J...",
  "idempotencyKey": "turn-client-7f9c",
  "admission": "queue",
  "input": {
    "text": "Inspect the failing test and propose a fix.",
    "attachments": []
  },
  "context": {
    "requestId": "req_turn_1",
    "expectedRevision": 22
  }
}
```

Response:

```json
{
  "accepted": true,
  "turn": {
    "id": "turn_01J...",
    "sessionId": "ses_01J...",
    "status": "queued",
    "admission": "queue",
    "queuePosition": 1,
    "effectivePermissionMode": "ask",
    "idempotencyKey": "turn-client-7f9c"
  },
  "cursor": { "epoch": "ep_7f", "sequence": 315 }
}
```

The response is an admission result, not the final model response. Repeating
the same request with the same principal and idempotency key returns the same
turn. Reusing the key with different input returns `IDEMPOTENCY_CONFLICT`.

`admission` defaults to `reject_if_busy`, which returns `AGENT_BUSY` while a
turn is active, exactly like a direct local prompt. `queue` places the turn in
the Host-owned per-session queue; the Host releases queued turns in order
after the active turn's terminal event and emits `turn.queued` immediately.
The queue lives in the Host so every client, including the local desktop,
sees the same pending prompts; a client-side queue is not part of the
contract. A full queue returns `AGENT_BUSY` with `details.queueFull: true`.

The Host applies a remote permission ceiling: a turn started by a remote
principal runs under the lower of `Session.permissionMode` and the Host's
`remoteMaxPermissionMode` (default `ask`, ordered `ask` <
`accept-edits` < `auto`) unless the principal also holds `approver` and Host
policy allows approvers to use the session's own mode. The result reports the
applied value as `effectivePermissionMode`; the durable session mode is never
changed by the ceiling. A desktop device paired through the SSH bootstrap
holds `owner` and is exempt from the ceiling by default; the Host policy
`applyCeilingToPairedDevices` re-applies it
(`05-security/02-remote-control-security.md` §4.3).

### 7.4 `turn/stop`, `turn/interrupt`, and `turn/cancel`

Request:

```json
{
  "turnId": "turn_01J...",
  "reason": "user_requested",
  "context": {
    "requestId": "req_interrupt_1",
    "idempotencyKey": "interrupt-turn_01J..."
  }
}
```

The three operations share this shape and each returns the current turn state.

- `turn/stop` is the local graceful stop: the Host finishes the current
  assistant response and tool batch, then ends the turn as `completed` at the
  next boundary and releases the next queued turn. It does not cancel an
  active provider stream or running tool.
- `turn/interrupt` is the local abort: the Host stops the stream, cancels
  interruptible tools, and ends the turn as `interrupted`. Completed writes
  are never rolled back. On a queued turn it behaves as `turn/cancel`.
- `turn/cancel` removes a queued turn and marks it `canceled`; on a started
  turn it returns `CONFLICT`.
- `turn/prioritize` moves a queued turn to the head of its session's queue
  (the desktop's "send now") and emits `turn.queued` with the new position;
  it never touches the running turn, so a client that wants the entry to
  start at the next boundary also calls `turn/stop`. On a started turn it
  returns `CONFLICT`.

A late call after a terminal event is a successful no-op. None of the three
rewinds a persisted transcript.

### 7.5 `approval/respond` and `input/respond`

`approval/respond` carries an `ApprovalResponse`; `input/respond` carries an
`InputResponse` (§5.5). Both require `context.idempotencyKey` and
`context.expectedRevision`. The Host verifies the request id, session, turn,
principal role, expiry, allowed decision, permission-mode selection, and
current revision in one operation and answers with the resulting state:

```json
{
  "approvalId": "approval_01J...",
  "status": "resolved",
  "decision": "allow-session",
  "alreadyResolved": false,
  "revision": 23
}
```

A second valid response for an already-resolved request returns the stored
result with `alreadyResolved: true`; it never re-executes or reverses the
decision.

### 7.6 `session/history`

Request:

```json
{
  "sessionId": "ses_01J...",
  "beforeItemId": "item_01J...",
  "limit": 100,
  "context": { "requestId": "req_history_1" }
}
```

The response is `{ items: ItemSummary[], hasMore: boolean, revision: number }`
ordered oldest to newest. `limit` is capped at 200. Omitting `beforeItemId`
returns the page that precedes the snapshot's `items`. The same operation
returns a single complete item when a truncated event points at it.

### 7.7 `host/list` and `project/list`

`host/list` returns `HostSummary[]` and exists only behind a Gateway; a direct
Host connection returns `METHOD_NOT_FOUND`. `project/list` returns
`ProjectSummary[]` for the projects the principal may create sessions under,
so `session/create` never needs a path.

## 8. Event replay and backpressure

The Host MUST retain enough durable events to cover the configured replay
window. The initial target is:

- 10,000 durable events per session or 24 hours, whichever comes first;
- ephemeral events are never retained;
- eight subscriptions per session per principal;
- sixteen connected clients per Agent Host;
- one megabyte maximum encoded event/frame; and
- a bounded per-connection send queue.

Because deltas and activity phases are ephemeral, a long streaming turn cannot
exhaust the replay window by itself; the window is consumed only by item and
lifecycle boundaries.

Where the log lives is an ownership decision, not a binding detail. In the
first implementation the durable event log is kept in Agent Host process
memory, a Host restart therefore starts a new epoch, and every reconnecting
client resynchronizes from a snapshot. Rust host-core owns SQLite exclusively
(frozen decision 12); moving the log into host-core requires its own ADR and a
schema decision, and is not implied by this specification.

The Host MAY evict old durable events after the limit. Eviction and epoch
change MUST make the cursor invalid and cause `resync.required`, never silent
loss.

WebSocket clients SHOULD send `events/ack` with the highest applied durable
sequence. The Host MAY use the acknowledgment to release transport buffers, but
it MUST NOT delete durable session state solely because a client acknowledged
an event.

When a client is too slow for the send queue, the Host MAY drop ephemeral
events first. If durable events would be lost, it MUST close the subscription
or connection with `CLIENT_TOO_SLOW` and include the last safely queued
cursor. The client reconnects with that cursor.

## 9. Server-initiated approval and input

### 9.1 WebSocket

The Host sends:

```json
{
  "jsonrpc": "2.0",
  "id": "server-request-42",
  "method": "approval/request",
  "params": {
    "approval": {
      "id": "approval_01J...",
      "sessionId": "ses_01J...",
      "turnId": "turn_01J...",
      "kind": "tool",
      "summary": "Run the selected shell command",
      "toolName": "Bash",
      "risk": "medium",
      "expiresAt": "2026-09-09T12:00:00.000Z",
      "revision": 22,
      "allowedDecisions": ["allow-once", "allow-session", "deny"]
    }
  }
}
```

The client responds to the same JSON-RPC id with an `ApprovalResponse`. The
Host then emits `approval.resolved` to every subscriber, including the local
desktop renderer, so an open confirmation card closes wherever it is shown.

### 9.2 HTTP/SSE

The Host emits an `approval.requested` SSE event. The client calls:

```text
POST /v1/approvals/{approvalId}:respond
```

with an `ApprovalResponse`. Closing the SSE stream does not approve, reject,
or cancel the approval.

### 9.3 Resolution rules

Only the Host may move an approval or input request to a terminal state. The
first valid decision wins whether it arrives as a server-request response, an
`approval/respond` call, or the local desktop card; later valid responses
return the stored result with `alreadyResolved: true`. Expiry, stale session
revision, an unknown request id, a decision outside `allowedDecisions`, or a
missing `permissionMode` on a contract approval fails closed.

Pending requests are Host state, not connection state. Host-core already owns
the pending permission table and its timer; the Agent Host exposes that table
through a `permissions.pending` read so a late-attaching client receives open
requests in its snapshot and every client sees the same resolution.

### 9.4 Relayed tool execution

A desktop paired as `owner` MAY advertise tools that execute on the desktop
(`tools/advertise`): its user-configured MCP servers and plugin tools that do
not require the session workspace. The Host merges them into that session's
catalog as relayed tools while the advertising connection lives. When the
Agent calls one, the Host runs its normal permission flow first, then sends
a server request on the advertising connection:

```json
{
  "jsonrpc": "2.0",
  "id": "server-request-77",
  "method": "tool/execute",
  "params": {
    "executionId": "exec_01J...",
    "sessionId": "ses_01J...",
    "turnId": "turn_01J...",
    "toolCallId": "call_01J...",
    "toolName": "mcp_corp_search",
    "args": { "query": "release notes" }
  }
}
```

The client executes the tool locally under its own plugin permissions and
confirmation rules and responds with `{ result, isError }` bounded by
`maxFrameBytes`, or with an error. Rules:

1. A relayed tool never runs on the Host and never receives Host secrets; the
   Host passes only the Agent's arguments, which are untrusted.
2. The Host-side permission decision, including session grants, precedes the
   relay request; the client does not re-ask the Host.
3. The request deadline is the tool's own timeout. If the advertising
   connection is gone or does not answer, the tool fails with `TOOL_FAILED`
   and the turn continues; nothing is retried on another connection.
4. Plugin tools whose manifest requires workspace or filesystem access are
   not accepted by `tools/advertise`, because they would act on the desktop's
   filesystem while the session root is on the Host.
5. Relayed results are items like any other and are audited on both sides.

## 10. Attachments

Small text and image inputs MAY be embedded in `turn/start` when their encoded
request remains below `maxPromptBytes`. Larger inputs use this flow:

1. `attachment/create` returns an opaque attachment id and an upload target.
2. The client uploads bytes over an authenticated HTTPS request.
3. `attachment/complete` supplies size and SHA-256.
4. The Host verifies the bytes, stores them in session-scoped scratch or
   attachment storage, and marks the attachment `ready`.
5. `turn/start` references only the ready attachment id.

Upload targets MUST be single-purpose, size-bounded, short-lived, and scoped to
one principal and session. A remote path, `file://` URL, or arbitrary URL MUST
not be accepted as a substitute for an upload.

Behind a Gateway the Host has no inbound port, so the upload target is served
by the Gateway and the bytes cross the Host link in bounded chunks (§11.4).
The Gateway holds them only until `attachment/complete` succeeds or the upload
expires, verifies nothing beyond size, and never inspects or persists them
further; the Host performs the hash and MIME verification.

## 11. Transport mappings

### 11.1 WebSocket JSON-RPC (`RACP-WS`, normative v1 binding)

- Endpoint: `wss://<authority>/v1/racp/ws`, or
  `wss://<gateway>/v1/hosts/{hostId}/racp/ws` behind a Gateway
- Subprotocol: `pi-racp.v1.jsonrpc`
- One UTF-8 JSON-RPC message per text frame
- Full-duplex server requests enabled
- Ping/pong heartbeat target: 30 seconds

Authentication happens on the HTTP upgrade request and never in the URL query
string. Browsers cannot set request headers on the `WebSocket` API, so the
binding defines two authentication profiles:

- **Non-browser clients** send `Authorization: Bearer <access token>` on the
  upgrade request.
- **Browser clients** rely on a cookie-backed Gateway session
  (`HttpOnly`, `Secure`, `SameSite=Lax` or stricter) plus the per-tenant
  Origin allowlist checked on the upgrade, and a CSRF token on every mutation
  sent over the socket after `connection/initialize`.

A token in the URL is rejected in both profiles.

First deployment (rollout R2): a `pi-host` binds loopback on the remote
machine and the desktop reaches it through an SSH port forward on the header
profile with a device token obtained by the SSH bootstrap pairing. Plain
`ws://` is accepted on that port only when both the bind address and the peer
address are loopback; the SSH channel provides confidentiality
(`05-security/02-remote-control-security.md` §5.1). The cookie profile ships
with the unscheduled browser milestone.

### 11.2 HTTP/JSON + SSE (`RACP-HTTP`, browser profile)

| Operation family | HTTP mapping |
|---|---|
| Capabilities | `GET /v1/capabilities` |
| List hosts (Gateway only) | `GET /v1/hosts` |
| List projects | `GET /v1/projects` |
| List sessions | `GET /v1/sessions` |
| Create session | `POST /v1/sessions` |
| Get/attach session | `GET /v1/sessions/{sessionId}` / `POST ...:attach` |
| Session history | `GET /v1/sessions/{sessionId}/history` |
| Start turn | `POST /v1/sessions/{sessionId}/turns` |
| Get turn | `GET /v1/turns/{turnId}` |
| Stop / interrupt / cancel turn | `POST /v1/turns/{turnId}:stop` / `:interrupt` / `:cancel` |
| Prioritize turn | `POST /v1/turns/{turnId}:prioritize` |
| Session event stream | `GET /v1/sessions/{sessionId}/events` |
| Host event stream | `GET /v1/events` |
| Resolve approval | `POST /v1/approvals/{approvalId}:respond` |
| Resolve input | `POST /v1/inputs/{inputId}:respond` |

The event endpoints MUST support `Last-Event-ID` with the `"<epoch>:<sequence>"`
form. Commands return JSON and never require the caller to keep a request open
for turn execution.

The same two authentication profiles apply. A browser `EventSource` cannot set
headers, so it uses the cookie session and Origin allowlist; a browser client
MAY instead consume the stream through `fetch` with header authentication, in
which case it sends `Last-Event-ID` as a request header itself and implements
its own reconnect.

`RACP-HTTP` is required before any browser client ships. The browser
milestone is unscheduled (D375); the mapping is retained so the contract does
not drift, and the binding joins the conformance fixture with `RACP-WS` when
it is scheduled.

### 11.3 gRPC (`RACP-GRPC`, reserved)

gRPC is not part of the v1 conformance surface. It is reserved for a typed
service binding if a native service client or a Gateway implementation needs
it after the semantic model has stabilized. If adopted:

- the `.proto` file is generated from the typebox source of §5, never written
  by hand, and preserves field meaning, enums, and state transitions;
- `SubscribeEvents` is a server stream, not a long-running `StartTurn` call;
- authentication, principal, idempotency, cursor, and error semantics map to
  metadata and status without changing their meaning; and
- the binding joins the same conformance fixture before it ships.

Reserving gRPC rather than requiring it keeps v1 at one interactive binding
and one browser profile; the Host link (§11.4) uses `RACP-WS` framing.

### 11.4 Host link relay profile

The Host link belongs to the unscheduled Gateway milestone (D375). It is
specified here so the contract does not drift; the SSH-tunnel topology does
not use it.

The Host link is the outbound connection from an Agent Host to a Gateway. It
is not a third client binding: it multiplexes logical client connections onto
one authenticated WebSocket so that every RACP rule above applies per logical
connection.

```ts
type HostLinkFrame =
  | { link: "racp-hostlink.v1"; type: "client.open"; clientConnectionId: string; routeContext: string }
  | { link: "racp-hostlink.v1"; type: "client.message"; clientConnectionId: string; message: unknown }
  | { link: "racp-hostlink.v1"; type: "client.close"; clientConnectionId: string; reason: string }
  | { link: "racp-hostlink.v1"; type: "host.message"; clientConnectionId: string; message: unknown }
  | { link: "racp-hostlink.v1"; type: "host.close"; clientConnectionId: string; code: string }
  | { link: "racp-hostlink.v1"; type: "attachment.chunk"; uploadId: string; offset: number; last: boolean }
  | { link: "racp-hostlink.v1"; type: "link.ping" | "link.pong" }
```

Rules:

1. `client.open` carries the signed `HostRouteContext` for that client. The
   Host authorizes every operation on the logical connection from that
   context alone; the link's own mTLS identity authenticates the Gateway, not
   any user.
2. Each logical connection has its own `connection/initialize`, subscriptions,
   server-request id space, and send queue. A server-initiated request is
   addressed to a `clientConnectionId`; the Gateway relays it on the matching
   client connection and relays the response back on the same logical
   connection, which satisfies §4.3.
3. The Gateway MUST NOT renumber, reorder, coalesce, or re-key anything inside
   `message`. It MAY drop ephemeral events for a slow client; it MUST close
   that logical connection with `CLIENT_TOO_SLOW` rather than drop a durable
   event.
4. `attachment.chunk` frames are followed by one binary WebSocket frame of at
   most 256 KiB and are the only binary payload permitted on the link.
5. Loss of the link closes every logical connection with a resumable cursor.
   The Host reconnects with bounded exponential backoff; local turns continue
   throughout.

## 12. Limits and deadlines

The initial target limits are:

| Limit | Target |
|---|---:|
| JSON request or event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Attachment | 50 MiB |
| Host link attachment chunk | 256 KiB |
| Durable session event replay | 10,000 events or 24 hours |
| Ephemeral events | Not retained |
| Queued turns per session | 8 |
| Concurrent subscriptions per connection | 8 |
| Connected clients per Agent Host | 16 |
| `connection/initialize` deadline | 10 seconds |
| Read/metadata operation deadline | 15 seconds |
| `turn/start` admission deadline | 5 seconds |
| Approval lifetime, local default | 120 seconds, then deny |
| Approval lifetime, remote policy | 30 minutes by default while a remote subscriber is attached; Host-configured, bounded, advertised as `approvalLifetimeMs` |
| Heartbeat interval | 30 seconds |
| Terminal output replay ring | 128 KiB per terminal |
| Open terminals per session | 2 |
| Relayed tool execution deadline | The tool's own timeout |

The Host MAY advertise stricter limits. It MUST return a structured limit
error rather than truncating a command silently.

Approval lifetime is a Host policy. The local default stays at 120 seconds
then deny (frozen decision 17). While a remote subscriber is attached the
default lifetime is 30 minutes (D375), because a remote approver is rarely at
the keyboard; the Host operator may shorten or lengthen it within a bound, the
tool call stays blocked for that lifetime unless a local or remote decision
arrives earlier, and a disconnect never extends it.

## 13. Errors

Every failed operation returns a JSON-RPC error or HTTP status with this
semantic payload:

```ts
type RemoteError = {
  code: string
  message: string
  retriable: boolean
  traceId: string
  details?: unknown
}
```

Initial RACP codes are:

| Code | Retriable | Meaning |
|---|---:|---|
| `UNAUTHORIZED` | no | Missing, expired, or invalid credential |
| `FORBIDDEN` | no | Principal lacks the operation or session scope |
| `PROTOCOL_MISMATCH` | no | Unsupported major version or required capability |
| `INVALID_ARGUMENT` | no | Request schema or field value invalid |
| `NOT_FOUND` | no | Host, project, session, turn, approval, input, or attachment missing |
| `AGENT_UNAVAILABLE` | yes | Host or runtime is offline |
| `AGENT_BUSY` | no | Session cannot admit the turn under the requested admission mode, or the queue is full |
| `CONFLICT` | yes | Expected revision is stale or the turn is no longer in the required state |
| `IDEMPOTENCY_CONFLICT` | no | Same key was reused with different input |
| `CURSOR_EXPIRED` | no | Epoch changed or the replay window no longer contains the cursor |
| `CLIENT_TOO_SLOW` | yes | Bounded event queue was exceeded |
| `APPROVAL_EXPIRED` | no | Approval is no longer executable; maps from `PERMISSION_TIMEOUT` and `PLAN_APPROVAL_TIMEOUT` |
| `APPROVAL_STALE` | no | Approval response targets an old revision |
| `PAYLOAD_TOO_LARGE` | no | Request, event, or attachment exceeds a limit |
| `RATE_LIMITED` | yes | Principal, session, or host quota exceeded |
| `INTERNAL` | maybe | Unexpected failure with a trace id |

Implementations MUST map these codes into the shared `AppError` vocabulary
before adding them to production code. The same error code MUST mean the same
thing across all bindings.

## 14. Compatibility and conformance

1. New fields are additive. Existing field names and enum meanings are never
   reused.
2. Clients ignore unknown response fields and preserve unknown event kinds for
   diagnostics.
3. A server advertises optional capabilities before a client uses them.
4. A server never changes a terminal turn, approval, or input request back to
   an active state.
5. The typebox schemas in `packages/shared` are the single source of the
   contract. JSON Schema fixtures, documentation tables, and any Protobuf file
   are generated from them; a hand-maintained second contract is a defect.
6. A binding conformance suite runs the same command/event trace through
   every shipped binding. `RACP-WS` is the reference binding; `RACP-HTTP`
   joins before a browser client ships; a reserved binding joins before it
   ships.
7. Conformance covers duplicate mutations, cursor replay, epoch change, cursor
   expiry, queued-turn ordering, approval decisions including `allow-session`
   and permission-mode selection, approval expiry, slow clients,
   authorization, the remote permission ceiling, relayed tool execution,
   terminal streaming, queue restoration after a restart, attachment hashes,
   and host restart recovery.
8. The client treats a new major protocol version as incompatible unless an
   explicit compatibility adapter is selected.

## 15. Amendment history

D374 (2026-09-10) revised the D373 draft before implementation:

- approval and input decisions became a superset of the local
  `allow-once` / `allow-session` / `deny`, `approve` / `reject` plus
  permission mode, and asktool answer contracts;
- cursors gained an `epoch`; deltas and activity phases became ephemeral and
  left the replay window; the first log lives in Host memory;
- envelopes gained `parentToolCallId` / `agentName` and carry the shared
  `AgentEvent`; the local-to-RACP mapping table and the
  `turn.completed` = `agent_end` rule were added;
- `host/list`, `project/list`, `session/history`, host-scope subscriptions,
  `turn/stop`, `turn/cancel`, the Host-owned turn queue, and the deferred
  operation list were added; `turn/interrupt` became the immediate abort;
- `RACP-WS` became the only normative v1 binding, `RACP-HTTP` the browser
  profile, `RACP-GRPC` reserved; typebox became the single IDL;
- browser authentication profiles, the Host link relay profile, the remote
  permission ceiling, and the remote approval lifetime policy were defined;
- `replayComplete`, a single `revision`, `ItemSummary`, and the
  `APPROVAL_EXPIRED` mapping replaced the inconsistent draft names.

D375 (2026-09-10) re-sequenced the deployments and extended the catalog:

- the remote-host profile (§6.2) with `session/configure`, `session/fork`,
  `session/rename`, `session/delete`, `session/compact`, `workspace/list`,
  `workspace/read`, and `workspace/diff`, advertised as `remoteHostProfile`;
- the SSH-tunnel deployment of `RACP-WS` with the loopback rule and the
  ceiling exemption for SSH-paired owner devices;
- `RACP-HTTP`, the cookie profile, and the Host link marked as belonging to
  unscheduled milestones;
- `terminal/open`, `terminal/input`, `terminal/resize`, `terminal/close`, the
  `terminal.changed` / `terminal.output` kinds, `tools/advertise`, the
  `tool/execute` server request (§9.4), and `turn/prioritize` for the
  desktop's "send now", all in the same milestone; and
- queued turns persisted by host-core and held after a restart, the
  30-minute default approval lifetime for remote subscribers, and the
  `applyCeilingToPairedDevices` policy.

