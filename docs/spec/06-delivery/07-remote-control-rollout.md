# Remote Agent Control Rollout and Acceptance

- Status: Target delivery specification; post-MVP
- Decision: D373 / ADR 0205, amended by D376
- Normative protocol: `03-runtime/19-remote-agent-control-protocol.md`
- Normative security: `05-security/02-remote-control-security.md`

## 1. Delivery boundary

Remote control is a post-MVP capability. The current MVP continues to ship:

- Electron Main as the local orchestrator;
- Node pi sidecar as the Agent runtime;
- Rust host-core over local stdio NDJSON JSON-RPC;
- optional loopback-only MCP control under ADR 0203; and
- no public or LAN Gateway listener.

Remote work MUST NOT begin by exposing the existing host-core or IPC endpoint.
The implementation starts with the typebox contract, the headless Agent Host
module, and conformance tests, then adds transport bindings behind explicit
feature flags.

## 2. Milestones

### R0 — Contract and test fixtures

Deliver:

- RACP v1 resource and operation schemas as typebox definitions in
  `packages/shared`, the single source of the contract;
- generated JSON Schema fixtures and shared request/response/event traces;
- error mapping and capability negotiation fixtures;
- cursor, epoch, snapshot, idempotency, turn-queue, and approval
  state-machine tests, including `allow-session` and Plan/Goal
  permission-mode selection;
- binding-independent authorization test vectors, including the remote
  permission ceiling; and
- threat model review against the security specification.

Exit criteria:

1. A fixture trace has an identical semantic result for every shipped
   binding adapter.
2. Duplicate, stale, expired, and unauthorized requests have deterministic
   outcomes.
3. No fixture requires direct host-core or renderer access.
4. No hand-written second copy of the contract exists.

### R1 — Headless Agent Host module

Deliver `packages/agent-host`, a module with no Electron dependency that
owns session and turn admission, the per-session turn queue, the approval
broker, the in-memory event log with epochs, and the snapshot builder
including active items and pending requests. Electron Main hosts it; the
existing IPC handlers become adapters over it, incrementally if needed. Two
local changes ship with it:

- Rust host-core exposes `permissions.pending` so a late-attaching client
  receives open requests; and
- the renderer's in-memory prompt queue is replaced by the Host-owned turn
  queue, so every client sees the same pending prompts.

A development-only loopback RACP-WS endpoint drives the module; it is not
reachable outside loopback or an explicit development tunnel.

Exit criteria:

1. A client can close and reopen without interrupting a turn.
2. A stale cursor or a new epoch results in a snapshot, not an invented event
   sequence.
3. Existing local renderer behavior and the local MCP control plane are
   unchanged, and the desktop's queued prompts now come from the Host queue.
4. The module's test suite runs without Electron.
5. A client that attaches during an open approval sees it in the snapshot and
   its decision closes the local desktop card.

### R2 — Primary WebSocket binding

Deliver `RACP-WS` over WSS for native clients and Electron clients on the
header authentication profile. Add authentication, per-connection limits,
server requests, heartbeats, bounded event queues with ephemeral-first drop,
the remote permission ceiling, and revocation.

Exit criteria:

- E2E-221 through E2E-226 pass in an isolated remote harness (E2E-226 with
  its single-tenant profile);
- a slow client cannot stall or exhaust the Host;
- an authenticated second viewer receives the same durable event sequence;
- approval decisions, including `allow-session` and Plan/Goal permission
  mode, are bound to principal, Session, turn, and revision; and
- a remote-initiated turn never exceeds the configured ceiling.

### R3 — Gateway and Host link

Deliver a separate Remote Gateway and a standalone Agent Host mode. The Host
opens the outbound Host link (`racp-hostlink.v1`); the Gateway performs
identity, routing, rate limits, audit, revocation, and transient attachment
relay. The identity source (OIDC/OAuth 2.0 provider or first-party product
account service) is recorded as a decision when this milestone starts.

Exit criteria:

1. A Host behind inbound firewall/NAT can connect without an open desktop
   listener.
2. A Gateway restart does not lose a local turn or duplicate a mutation.
3. Revoking a Host or user closes active connections, blocks new commands,
   and cancels that principal's queued turns.
4. Gateway storage contains no provider secrets, unredacted transcript data,
   or attachment bytes after the upload window.
5. A relayed server-initiated approval request is answered exactly once on
   the logical connection that received it.

### R4 — Browser profile

Deliver `RACP-HTTP` and the cookie authentication profile for browser
clients on both `RACP-WS` and SSE. Commands are short HTTP requests; events
use SSE with `Last-Event-ID` in the `epoch:sequence` form. Approval and input
responses use explicit POST endpoints.

Exit criteria:

- browser reconnect after a network switch replays or resynchronizes;
- Origin, CORS, CSRF, cookie, and URL-token handling pass security tests;
- HTTP binding results match the WebSocket fixture traces; and
- no command waits for the entire Agent turn.

### R5 — Reserved gRPC binding

`RACP-GRPC` is delivered only when a named native service consumer or
Gateway implementation needs it. Generate the `.proto` and clients from the
typebox source; do not maintain an independent hand-written gRPC contract.
It is not a release gate for remote control.

Exit criteria, if delivered:

- unary commands and server-stream event subscriptions pass binding parity;
- deadlines, cancellation, metadata, and status preserve RACP semantics;
- a gRPC client can resume from a cursor after stream failure; and
- long-lived stream behavior has explicit load-balancer and connection-health
  tests.

## 3. Implementation rules

### 3.1 Preserve the local path

The RACP server calls the headless Agent Host module, which calls the same
host and sidecar paths the renderer uses. It does not call the renderer,
`host.proxy`, or Rust host-core from a network listener. The standalone Host
later moves the module and supervision without changing RACP.

### 3.2 Keep the Agent independent of clients

The Host owns active turns, the turn queue, and event cursors. Client
lifetime, browser tab lifetime, and Electron window visibility do not control
Agent execution. A client must explicitly call `turn/stop` or
`turn/interrupt` to end a turn.

### 3.3 Keep the queue in the Host

Queued prompts are Host state. No client, including the local renderer,
keeps a private queue once the module ships; a queued turn is visible to
every attached client and can be canceled by any controller.

### 3.4 Make replay a first-class test surface

Every event-producing test records:

- the initial snapshot revision and cursor;
- the exact command and idempotency key;
- every durable event sequence applied;
- the disconnect point;
- the replay request; and
- the final snapshot hash.

The test fails if a duplicate, gap, out-of-order durable event, or
unannounced state change appears. Ephemeral events are excluded from ordering
assertions and must be reconstructible from the snapshot's active items.

### 3.5 Keep bindings semantically equal

The conformance fixture is the source of truth for behavior. Each shipped
binding may choose its native status and serialization, but it must preserve:

- operation acceptance and rejection;
- authorization scope and the remote permission ceiling;
- idempotency result;
- durable event order and cursor;
- queue order;
- approval lifecycle and decision vocabulary;
- attachment hash and size checks; and
- terminal turn state.

## 4. Validation plan

### 4.1 Unit and contract validation

- generated schema validation for every request, response, and event;
- state-machine transition tests for Session, Turn, turn queue, Approval,
  Input, and Attachment;
- idempotency tests with lost response and retry;
- cursor replay, epoch change, expiry, gap, and snapshot tests;
- authorization matrix tests for every role and operation, including the
  permission ceiling and `allow-session` policy;
- redaction tests for prompts, tool data, credentials, pending-request reads,
  and attachments; and
- generated binding round-trip tests.

### 4.2 Integration validation

- the headless module inside Electron Main with the real sidecar and
  host-core supervision;
- standalone Host with a real workspace fixture;
- Gateway routing across at least two Hosts;
- two tenants, only once a multi-tenant harness exists;
- browser WSS and SSE reconnect across a network interruption on the cookie
  profile;
- outbound Host link through a firewall/NAT test harness, including relayed
  server requests and attachment chunks;
- host restart while a turn is running and turns are queued; and
- Gateway restart while a Host turn is running.

### 4.3 Security validation

- invalid, expired, revoked, and wrong-tenant tokens;
- wrong role, wrong Session, wrong Host, and stale revision;
- Origin, CORS, CSRF, cookie, and WebSocket upgrade checks on both profiles;
- SSRF and arbitrary file/path attempts;
- oversized and hash-mismatched uploads, including through the Gateway relay;
- prompt-injected requests attempting to select secrets or permissions;
- remote turns on `auto` sessions with and without a raised ceiling;
- slow-reader and connection-exhaustion tests; and
- audit-log redaction and retention checks.

### 4.4 Operational validation

Record at minimum:

- turn admission latency and queue depth;
- event delivery latency and sequence lag;
- replay, resync, and epoch-change counts;
- approval wait time and expiry count;
- Host/Gateway connection health;
- authentication and authorization failures;
- event queue drops, ephemeral and durable separately; and
- active Host/Session/client counts.

The first production target is a bounded, observable remote control service,
not an unbounded real-time stream. Load tests must demonstrate that a slow or
disconnected client does not affect local Agent execution.

## 5. Rollout and rollback

1. Ship the typebox contract, generated fixtures, and disabled code paths
   first.
2. Enable R1 only in development profiles.
3. Enable RACP-WS for allowlisted test users and Hosts.
4. Add Gateway routing only after Host identity and revocation pass review.
5. Add the browser profile and any reserved binding as independent
   capabilities.
6. Keep a kill switch that rejects new remote connections and cancels queued
   turns submitted by remote principals while preserving already-running
   local desktop sessions.

Rollback MUST:

- stop accepting new remote connections;
- revoke or drain active remote connections according to incident policy;
- leave local stdio, renderer, and MCP paths usable;
- preserve completed local transcript data; and
- never replay a turn merely because a remote feature flag changed.

## 6. Release acceptance

The feature is not production-ready until:

1. all remote scenarios E2E-221 through E2E-230 are green in the approved
   remote harness;
2. the security acceptance gates in
   `05-security/02-remote-control-security.md` are signed off;
3. binding parity is demonstrated for every shipped binding, at minimum
   `RACP-WS` and `RACP-HTTP`;
4. a failure-injection run proves no duplicate execution after reconnect;
5. the Gateway and Host operational dashboards are available; and
6. a new release/rollback runbook names the feature flag, revocation path,
   data retention, and incident owner.

## 7. Amendment history

D376 (2026-09-10) replaced the Electron facade milestone with the headless
Agent Host module, added the Host queue and `permissions.pending` changes,
made `RACP-WS` the only normative v1 binding with a browser profile in R4 and
a reserved gRPC binding in R5, added the Host link relay and identity-source
decision to R3, and made tenant isolation tests conditional on a multi-tenant
harness.
