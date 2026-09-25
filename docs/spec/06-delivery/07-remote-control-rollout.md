# Remote Agent Control Rollout and Acceptance

- Status: Target delivery specification; post-MVP
- Decision: D373 / ADR 0205, amended by D374 and D375
- Normative protocol: `03-runtime/19-remote-agent-control-protocol.md`
- Normative security: `05-security/02-remote-control-security.md`

## 1. Delivery boundary and order

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

D375 fixes the order of the milestones around recorded demand rather than
around transport breadth:

- issues #176 and #140 ask to operate projects on a remote Linux or WSL
  machine from the local desktop, which is the SSH-tunnel remote Host
  topology;
- issue #100 asks for task completion and approval notifications on
  Telegram, WeChat, Slack, or a webhook, plus simple commands back, which is
  an outbound integration beside the Host; and
- no recorded request asks for a browser or phone client of the desktop, so
  the Gateway and browser milestones are unscheduled.

The scheduled order is R0, R1, R2, R3. Milestones marked unscheduled keep
their specifications so the contract does not drift, and they are scheduled
only by a later product decision.

## 2. Milestones

### R0 — Contract and test fixtures

Deliver:

- RACP v1 resource and operation schemas as typebox definitions in
  `packages/shared`, the single source of the contract, including the
  remote-host profile operations of protocol §6.2;
- generated JSON Schema fixtures and shared request/response/event traces;
- error mapping and capability negotiation fixtures;
- cursor, epoch, snapshot, idempotency, turn-queue, and approval
  state-machine tests, including `allow-session` and Plan/Goal
  permission-mode selection;
- binding-independent authorization test vectors, including the remote
  permission ceiling and the SSH-paired owner exemption; and
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
  queue, persisted by Rust host-core under its own ADR and schema bump
  (D375), restored after a restart and held until a controller attaches, so
  every client sees the same pending prompts and a reboot never starts work
  unattended.

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

Timing: the extraction starts after the release in flight ships, and each of
`permissions.pending`, the Host queue, and the module extraction lands as its
own commit, because the repository has concurrent sessions and 54 tests that
match `electron/main/index.ts` by source pattern and must be repointed.

### R2 — Remote Host over an SSH tunnel

Deliver the first remote topology (`02-architecture/05-remote-agent-control.md`
§5.2): the desktop as Remote Client of a headless Host on another machine.

R2 lands in two ordered slices so the desktop-side kernel can ship, be
tested, and stay dead code until the full topology is ready:

- **R2a — Desktop kernel (delivered, ADR 0286).** The single interception
  seam, the transport-agnostic backend, the event bridge, the coordinator, an
  encrypted-at-rest registry, and the boot hook. With an empty registry
  (default install) the kernel is a full no-op; the router has no remote
  backends, every renderer call still hits the local handler byte-for-byte.
  Every subsystem has a `node --test` fixture that exercises it against a
  fake — or, for the RACP adapter, against the real in-memory harness in
  `@pi-desktop/racp/test-harness`.
- **R2b — Pairing, SSH bootstrap, terminal, and reverse tool relay.** The
  remaining bullets below. R2's exit criteria stay unchanged and land with
  R2b; R2a alone is not user-visible and does not attempt them.

Deliverables:

- the `pi-host` bundle: the module, the Node pi sidecar, and the platform's
  host-core binary, versioned with the desktop, bound to loopback, downloaded
  from GitHub Releases by a bootstrap script the desktop uploads over SSH
  with the published SHA-256 verified before install, then started and paired
  over that SSH session;
- the desktop RACP client adapter in Electron Main under `lib/api.ts`, so the
  renderer needs no transport knowledge and a remote session renders like a
  local one;
- `RACP-WS` on the header profile over the forwarded port, with the loopback
  rule of security §5.1 and the device-token pairing of security §3.2;
- the remote-host profile operations (`session/configure`, `session/fork`,
  `session/rename`, `session/delete`, `session/compact`, `workspace/list`,
  `workspace/read`, `workspace/diff`) so mode, model, thinking level, and the
  work panel's files and diff work against the remote session; and
- the remote session ownership split of architecture §6.3;
- the reverse tool relay: `tools/advertise` and the `tool/execute` server
  request, so desktop MCP servers and workspace-free plugin tools run on the
  desktop for a remote session;
- the remote-only WorkPanel terminal: `terminal/open`, `terminal/input`,
  `terminal/resize`, `terminal/close`, `terminal.output`, and a bounded replay
  ring, running on the remote machine. In the first SSH topology only the
  SSH-paired owner device may open or operate it. Local desktop sessions remain
  terminal-free; Agent Bash remains a non-interactive tool whose output is in
  the transcript; and
- the Settings → Remote Hosts destination: a compact host inventory and one
  Add form with SSH and Pair tabs, no instructional copy, marked Experimental
  on the settings rail and page title because the topology may still fail, and
  shown — with its settings-search hits — only while developer mode is on
  (`04-ux/06-settings-ia.md` §1, §3).

Design decisions (D375, recorded 2026-09-10):

1. Provider configuration on the remote Host is written over the SSH
   bootstrap channel as Host-local configuration; nothing crosses RACP.
   Delivered by D628 / ADR 0310: a manual "Sync models…" action runs
   `pi-host provider-import` on the Host with the provider payload — keys
   included — on the SSH stdin, handed to the running Host over an owner-only
   Unix admin socket; no key crosses argv, logs, a remote file, or RACP, and no
   second host-core is spawned. Import is idempotent per provider and deletes
   nothing. Remote session entry (D627 / ADR 0308) then lists a paired Host's
   sessions as one sidebar group per Host and lets the user start a session on
   the Host, which runs under the Host's default model with no desktop-side
   model picker; a `remote:` id whose Host is offline fails closed instead of
   routing to the local handler.
2. Desktop user MCP servers and workspace-free plugin tools reach remote
   sessions through the reverse tool relay in this milestone; plugin tools
   that require workspace or filesystem access are excluded.
3. The WorkPanel terminal ships in this milestone for remote Host sessions
   only. The first SSH topology authorizes only the paired owner device to open,
   input, resize, or close a terminal; a controller or viewer cannot run a
   shell. The PTY runs as the `pi-host` OS user with the session root as its
   working directory, which is not a filesystem sandbox. Local desktop sessions
   remain terminal-free under ADR 0108; Agent Bash output remains in the
   transcript and is not a local interactive terminal.
4. `pi-host` is downloaded from GitHub Releases per platform at the desktop's
   version by a bootstrap script the desktop uploads over SSH, with the
   published SHA-256 verified; a version mismatch is `PROTOCOL_MISMATCH`
   and the desktop offers to re-run the download. A machine without outbound
   access to GitHub is not supported in the first version.
5. The SSH-paired desktop device holds `owner` and is exempt from the remote
   permission ceiling unless the Host policy `applyCeilingToPairedDevices`
   is enabled.
6. R2 ships as one milestone; it is not split into sub-milestones.

Exit criteria:

1. E2E-231 passes: a turn started from the desktop reads, writes, and runs
   commands on the remote machine only, approvals appear in the desktop card,
   and the remote host-core binds loopback only.
2. Dropping and restoring the SSH session mid-turn resumes by cursor without
   duplicating the turn.
3. Mode, model, and thinking-level changes on a remote session behave as
   locally, idle-only.
4. The remote tool catalog contains no desktop plugin tool.
5. A `pi-host` at another version is rejected and the update path is offered.
6. A desktop-configured MCP tool advertised for relay executes on the desktop
   during a remote turn, a workspace-requiring plugin tool is absent from the
   remote catalog, and closing the desktop mid-call fails the tool without
   interrupting the turn.
7. A terminal opened on a remote session runs on the remote machine inside
   the session root and its output resumes from the replay ring after an SSH
   drop.
8. The bootstrap download verifies the published checksum and refuses a
   tampered bundle.

### R3 — Outbound messaging integration

Deliver the integration adapter beside the Host (issue #100): a further
caller of the module inside the Host process, with no transport and no
inbound listener.

- It subscribes to host-scope and session events and relays redacted
  summaries of `turn.completed`, `turn.failed`, `approval.requested`, and
  `input.requested` to outbound channels: webhook first, then Telegram and
  Slack through their outbound polling or socket modes; channels that require
  an inbound callback are deferred.
- It maps a fixed command vocabulary from a linked chat to `turn/start`,
  `turn/stop`, `turn/interrupt`, and `approval/respond`, executed under the
  linked principal's roles and the same Host policy as any client; unlinked
  chats are ignored and audited.
- It never blocks a turn: delivery failures are logged and retried with a
  bound, and the Host runs the same whether the adapter is configured or not.

Exit criteria: E2E-232 passes; payloads contain summaries and ids only;
commands from an unlinked chat have no effect; the Host has no new listener.

### Unscheduled — Gateway and Host link (formerly R3)

A separate Remote Gateway and the outbound Host link
(`racp-hostlink.v1`) with identity, routing, rate limits, audit, revocation,
and transient attachment relay. PI does not operate it: a user runs it on
their own infrastructure and it admits clients with Host-issued device
credentials, so there is no identity source beyond the Host (D385). Exit criteria remain those of E2E-227.

### Unscheduled — Browser profile (formerly R4)

`RACP-HTTP` and the cookie authentication profile for browser clients on
both `RACP-WS` and SSE. Before it is scheduled, the browser client's first
needs are already covered by the remote-host profile (`session/configure`,
history, workspace reads); a Host-issued session cookie for Gateway-less use
still needs a specification clause. Exit criteria remain those of E2E-228.

### Reserved — gRPC binding (formerly R5)

`RACP-GRPC` is delivered only when a named native service consumer or
Gateway implementation needs it. Generate the `.proto` and clients from the
typebox source; do not maintain an independent hand-written gRPC contract.
It is not a release gate for remote control.

## 3. Implementation rules

### 3.1 Preserve the local path

The RACP server calls the headless Agent Host module, which calls the same
host and sidecar paths the renderer uses. It does not call the renderer,
`host.proxy`, or Rust host-core from a network listener. The `pi-host` bundle
runs the module and supervision on another machine without changing RACP.

### 3.2 Keep the Agent independent of clients

The Host owns active turns, the turn queue, and event cursors. Client
lifetime, browser tab lifetime, Electron window visibility, and SSH session
lifetime do not control Agent execution. A client must explicitly call
`turn/stop` or `turn/interrupt` to end a turn.

### 3.3 Keep the queue in the Host

Queued prompts are Host state. No client, including the local renderer,
keeps a private queue once the module ships; a queued turn is visible to
every attached client and can be canceled by any controller.

### 3.4 Keep the renderer transport-agnostic

The renderer reaches every backend through `lib/api.ts`. The desktop RACP
client adapter implements that surface for a remote Host; features the
remote-host profile does not cover are hidden by capability negotiation, not
stubbed. The renderer never learns whether a session is local or remote
beyond a display badge.

### 3.5 Make replay a first-class test surface

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

### 3.6 Keep bindings semantically equal

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
  permission ceiling, its SSH-paired exemption, and `allow-session` policy;
- redaction tests for prompts, tool data, credentials, pending-request reads,
  integration payloads, and attachments; and
- generated binding round-trip tests.

### 4.2 Integration validation

- the headless module inside Electron Main with the real sidecar and
  host-core supervision;
- a `pi-host` bundle on a Linux test machine reached through an SSH port
  forward, including bootstrap, pairing, version mismatch, and re-pairing;
- the desktop adapter rendering a remote session through the unchanged
  renderer;
- SSH session drop and restore while a remote turn is running;
- host restart while a turn is running and turns are queued, verifying that
  the persisted queue is restored and held;
- relayed tool execution and terminal streaming across an SSH drop;
- bootstrap download with a valid and a tampered checksum;
- the integration adapter against a webhook sink and a long-polling bot
  fixture; and
- when scheduled: Gateway routing across two Hosts, browser reconnect on the
  cookie profile, and the Host link relay through a NAT harness.

### 4.3 Security validation

- invalid, expired, revoked, and wrong-Host device tokens;
- non-loopback peers and non-loopback binds without TLS on a `pi-host`;
- pairing token reuse and pairing over a non-SSH channel;
- wrong role, wrong Session, wrong Host, and stale revision;
- SSRF and arbitrary file/path attempts, including `workspace/read` outside
  the session root;
- oversized and hash-mismatched uploads;
- prompt-injected requests attempting to select secrets or permissions;
- integration commands from unlinked chats and replayed commands;
- slow-reader and connection-exhaustion tests;
- audit-log redaction and retention checks; and
- when scheduled: Origin, CORS, CSRF, cookie, and Gateway relay checks.

### 4.4 Operational validation

Record at minimum:

- turn admission latency and queue depth;
- event delivery latency and sequence lag over the SSH forward;
- replay, resync, and epoch-change counts;
- approval wait time and expiry count;
- Host connection health, bootstrap duration, and version mismatches;
- authentication and authorization failures;
- integration delivery latency and retry counts;
- event queue drops, ephemeral and durable separately; and
- active Host/Session/client counts.

The first production target is a bounded, observable remote control service,
not an unbounded real-time stream. Load tests must demonstrate that a slow or
disconnected client does not affect Agent execution on either machine.

## 5. Rollout and rollback

1. Ship the typebox contract, generated fixtures, and disabled code paths
   first.
2. Enable R1 only in development profiles.
3. Enable the SSH-tunnel topology behind a feature flag for allowlisted test
   users, then generally.
4. Enable the integration adapter as an opt-in setting with no channel
   configured by default.
5. Schedule the Gateway, browser, and gRPC milestones only by a recorded
   product decision.
6. Keep a kill switch that rejects new remote connections and cancels queued
   turns submitted by remote principals while preserving already-running
   local desktop sessions.

Rollback MUST:

- stop accepting new remote connections and stop the integration adapter;
- leave a remote `pi-host` process running or stopped according to the
  user's choice, never deleting its transcripts;
- leave local stdio, renderer, and MCP paths usable;
- preserve completed local transcript data; and
- never replay a turn merely because a remote feature flag changed.

## 6. Release acceptance

The scheduled feature set is not production-ready until:

1. remote scenarios E2E-221 through E2E-226, E2E-229, E2E-230, and E2E-231
   are green in the approved remote harness, and E2E-232 for the integration
   adapter;
2. the security acceptance gates in
   `05-security/02-remote-control-security.md` that apply to the scheduled
   milestones are signed off;
3. a failure-injection run proves no duplicate execution after reconnect,
   including an SSH session drop;
4. `pi-host` bundles are published to GitHub Releases with checksums for
   every Linux platform the desktop's release pipeline publishes, and the
   version-mismatch and tampered-download paths are tested;
5. the Host operational metrics are available; and
6. a new release/rollback runbook names the feature flag, pairing revocation
   path, data retention on the remote machine, and incident owner.

Binding parity and E2E-227 / E2E-228 become gates when their milestones are
scheduled.

## 7. Implementation status

Recorded on the `feat/remote-agent-host` branch, 2026-09-10:

- R0 shipped: the RACP contract as typebox schemas in `packages/shared`
  (`racp.ts`), the generated JSON Schema fixture, the local-to-RACP event
  mapping, the remote permission ceiling, and the shared error codes.
- R1 shipped: host-core `permissions.pending`; the headless
  `packages/agent-host` module with the epoch event log, bounded fan-out,
  the approval broker, the turn queue, and the snapshot builder; the
  Electron bridge that hosts the module over the existing IPC handlers and
  feeds every agent event through it; and schema v15 with the persisted
  `turn_queue` and its RPC methods (D386 / ADR 0213).
- R1 shipped: the renderer's in-memory prompt queue is retired; the
  composer pushes through `agent/queue/push`, mirrors
  `agent/event/queueChanged`, and "send now" is `turn/prioritize` plus a
  graceful stop.
- R1 partial (2026-09-18): the runtime-level per-turn permission ceiling is
  plumbed end-to-end (`AgentPromptRequest.permissionMode` → agent-ipc →
  `RuntimeService.startTurn` → sidecar `agent.prompt`), and the bridge no
  longer fails closed on every session/effective-mode mismatch. A widening
  request (effective more permissive than session) is still refused as
  defence-in-depth; a narrower ceiling is forwarded and recorded by the
  sidecar as a documented stub. Turn-scoped enforcement in host-core
  (`session.beginTurn` accepting an override) is the remaining piece, so a
  narrower ceiling on a local turn does not yet clamp tool decisions.
- R1 permission-ceiling enforcement implemented (2026-09-25): the Host binds
  the policy-derived ceiling to each applicable durable turn, and host-core
  intersects it with tool and delegate scopes. A turn cannot widen the
  resolved Session mode; queued turns keep their ceiling across restart. The
  ceiling is Host-generated and is not a client-controlled RACP field. Layered
  tests pass; desktop SSH E2E acceptance remains pending under E2E-231.
- R2 started (2026-09-18, D447 / ADR 0284): `packages/host-runtime` holds the
  Electron-independent runtime layer — the host-core and sidecar stdio
  transports, the restart supervisor, `RuntimeService` (the module's
  `RuntimePort` with the durable turn lifecycle), transcript persistence, a
  headless launch resolver, and approved Plan/Goal dispatch — and Electron
  main runs on it through thin adapters.
- R2 (2026-09-18, D448 / ADR 0285): `packages/racp` holds the `RACP-WS`
  server and client cores, the `ws` binding on loopback, and device-token
  pairing; handshake, authorization, idempotency, queue order, approvals,
  cursor replay, eviction, epoch change, slow clients, and reconnect without
  duplicate execution are package tests. The `pi-host` bundle, the desktop
  adapter, and the SSH bootstrap have since started: the R2a desktop kernel
  (D449 / ADR 0286) brought the adapter and the bundle, and the SSH bootstrap
  followed in D453 / ADR 0292.
- R2b partial (2026-09-19, D453 / ADR 0292): the desktop installs and pairs
  a `pi-host` over the user's own `ssh` client with `BatchMode=yes`, so the
  user's configuration, agent, and jump hosts apply and no SSH secret reaches
  the app. `remote/pi-host-release.ts` holds the pure release coordinates
  (remote platform, desktop version, published SHA-256, refusal of unpublished
  targets) and `remote/pi-host-bootstrap-script.ts` generates the single
  `umask 077` script that downloads, verifies, installs under the remote
  `$HOME`, restarts the host on loopback with `--pair`, and echoes
  `PI_HOST_READY` / `PI_HOST_PAIRING_TOKEN`; `remote/ssh-transport.ts` is the
  injectable transport port and `remote/ssh-tunnel.ts` owns one durable
  `ssh -N -L` forward per host, re-established on every launch and adopted
  from the bootstrap so pairing opens exactly one tunnel. Records carry
  `metadata.transport = "ssh"` plus an SSH descriptor instead of a URL, and
  `pi-desktop/remoteHost/bootstrap` joins `list` / `pair` / `remove`. The
  terminal work-panel client, the reverse tool relay, and provider-configuration
  propagation over the SSH channel are not in this slice.
- R2b Host/RACP terminal slice (2026-09-25, ADR 0309): the Host owns the PTY
  service and RACP terminal operations, binds terminals to the SSH-paired owner,
  session, and active connection, and supports bounded output replay and safe
  reattachment. This Host/RACP slice does not itself deliver the Desktop
  terminal renderer, typed IPC/API, remote-backend operation routing,
  capability-to-UI wiring, or terminal event forwarding and UI lifecycle; those
  pieces are covered by the Desktop integration slice below. Local sessions
  remain terminal-free.
- R2b Host/RACP reverse tool relay slice (2026-09-25): `tools/advertise` now
  replaces an owner connection's per-Session catalog, disconnect clears it,
  and each remote turn receives a bounded snapshot whose entries remain pinned
  to the original connection and advertisement revision. Host-core tool
  execution routes through `tool/execute`; replacement, disconnect, timeout,
  or invalid response fails the tool as `TOOL_FAILED` without cross-connection
  retry, allowing the turn to continue. The RACP and Host Runtime contract
  tests cover this path. The Desktop global User MCP advertisement adapter is
  implemented and has targeted coverage in
  `apps/desktop/test/remote-tool-relay.test.mjs` and
  `apps/desktop/test/user-mcp.test.mjs`; it is limited to
  `toolsForProject(null)`. The CI workflow includes an isolated Linux `sshd`
  bootstrap fixture that verifies the production SSH
  transport, local release-bundle checksum/install, tunnel, pairing, and
  remote project/session reads. The host E2E additionally drives the production
  Desktop relay adapter through a deterministic model turn, checks failure and
  continuation when the Desktop relay closes mid-call, and verifies that an
  in-flight call is never rerouted to a replacement owner. It also covers
  remote Files/Review refresh, busy-session configuration conflicts, and stale
  terminal connections. The Linux SSH fixture now exercises a mid-turn tunnel
  drop and restore, cursor replay, idempotent turn retry, and PTY reattachment
  with the same `openRequestId`. These headless fixtures do not exercise the
  Desktop Settings/renderer flow, so E2E-231 remains Draft pending full Linux
  Desktop acceptance and the remaining security scenarios. Local headless runs
  pass 45/45 host checks and 20/20 permission-ceiling/queued-turn checks; the
  Linux SSH fixture has not been run in the current macOS environment.
  `workspaceFree` is an owner-side assertion that the
  Host cannot independently verify; the Desktop adapter must derive it from
  trusted source metadata and fail closed when uncertain. The initial adapter
  is limited to global User MCP tools from `toolsForProject(null)`; plugin
  tools remain disabled until a trusted classifier and product decision exist.
- R2b Desktop integration slice (2026-09-25): the remote WorkPanel now exposes
  Host-capability-gated terminals, routes terminal IPC through the owning
  remote Session, and keeps a stable open request ID per tab for reattachment.
  Reconnect restores Host and Session subscriptions by cursor before refreshing
  capabilities and re-advertising global User MCP tools. Hosts that are offline
  during startup retry in the background; remove, re-pair, and shutdown cancel
  stale attempts. Targeted Desktop suites and the headless remote Host E2E pass.
  `pi-host` now accepts explicit remote permission-ceiling and approval-lifetime
  policy through startup flags or environment variables. E2E-231 remains Draft
  until the Linux SSH Desktop scenario exercises the full Settings, approval,
  relay, reconnect, terminal, and security path; the SSH fixture currently
  covers pairing, remote reads, and headless reconnect behavior.

## 8. Amendment history

D374 (2026-09-10) replaced the Electron facade milestone with the headless
Agent Host module, added the Host queue and `permissions.pending` changes,
made `RACP-WS` the only normative v1 binding with a browser profile and a
reserved gRPC binding, added the Host link relay and identity-source
decision, and made tenant isolation tests conditional on a multi-tenant
harness.

D375 (2026-09-10) re-sequenced the milestones around recorded demand: R2 is
the SSH-tunnel remote Host with the desktop as client, R3 is the outbound
messaging integration, and the Gateway, browser, and gRPC milestones are
unscheduled. It added the `pi-host` bundle, the desktop adapter rule, and
E2E-231 / E2E-232 as the acceptance targets. Its design-gate answers,
recorded the same day, put the reverse tool relay and the terminal in R2 as
one milestone, download `pi-host` from GitHub Releases, persist the turn
queue in host-core, default the remote approval lifetime to 30 minutes, make
the paired-device exemption a Host policy, and fix the Gateway identity
source to the PI account service.

D385 (2026-09-10) withdrew the identity-source clause: remote control is
user-local by construction, and any Gateway is self-hosted and admits clients
with Host-issued device credentials.
