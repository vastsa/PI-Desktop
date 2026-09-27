# ADR 0205: Remote Agent Control Uses a Dedicated Host Boundary

- Status: Accepted for implementation (post-MVP); amended by D376
- Date: 2026-09-09
- Decision: D373 (amended by D376)
- Related: ADR 0004, ADR 0011, ADR 0203, ADR 0165,
  `02-architecture/05-remote-agent-control.md`,
  `03-runtime/19-remote-agent-control-protocol.md`,
  `05-security/02-remote-control-security.md`

## Context

PI-Desktop currently embeds `pi-agent-core` in a Node sidecar. Electron Main
owns the sidecar and Rust host-core bridges, while the renderer communicates
through typed Electron IPC. The local sidecar and host-core boundaries use
stdio NDJSON JSON-RPC. ADR 0203 adds an opt-in, loopback-only MCP control plane
for reviewed local desktop automation.

Remote control introduces a different trust and lifecycle problem. A remote UI
must be able to disconnect while a turn continues, reconnect without missing
events, answer host-owned approvals, and share a session with other clients.
Exposing the existing IPC, `host.proxy`, or host-core JSON-RPC would bypass the
current authority boundaries and make the Electron process a public backend.

The GitHub implementations reviewed for this decision converge on a layered
model: OpenAI Codex and Microsoft VS Code use JSON-RPC-shaped interactive host
protocols; MCP separates local stdio from remote HTTP streaming; Google A2A
separates a canonical operation model from JSON-RPC, gRPC, and HTTP/JSON
bindings.

## Decision

1. Keep Electron Main, the Node pi sidecar, and Rust host-core as the local
   authority path. Rust host-core continues to bind no network port.
2. Define a logical **Agent Host** boundary that owns sessions, turns, event
   sequences, approvals, attachments, workspace policy, and crash recovery.
3. Define the **PI Remote Agent Control Protocol (RACP) v1** as a
   transport-neutral semantic contract.
4. Use JSON-RPC over WSS as the primary interactive remote binding, HTTP/JSON
   plus SSE as the browser binding, and gRPC over TLS as the native and
   Gateway-to-Host binding. These bindings MUST share the same state machine,
   cursor, idempotency, authorization, and error semantics.
5. Put authentication, user authorization, routing, rate limiting, revocation,
   and audit at a separate Remote Gateway in production. The Agent Host opens
   the Gateway connection outbound so a desktop does not require a public
   inbound port.
6. During migration, Electron Main may host a development-only facade above
   existing handlers. Production deployment targets a standalone Agent Host
   process group beside the workspace; the wire contract does not change.
7. Keep remote control post-MVP. ADR 0004 remains true for the current MVP;
   this ADR is the dedicated follow-up required by its Follow-up section.
8. Do not reuse the withdrawn subagent A2A/Peer coordination mechanism. A2A
   is a design reference for binding separation only.

## Consequences

### Positive

- Local security boundaries remain intact.
- A running Agent is independent of any one UI connection.
- WebSocket, browser HTTP/SSE, and gRPC clients can share one semantic API.
- Event cursors, snapshots, idempotency, and approval lifecycles are explicit.
- A Gateway can route multiple Hosts without owning workspace secrets or
  durable transcript truth.
- Go, Rust, Node, and browser clients can use the binding most natural to
  their deployment without creating separate product behavior.

### Costs and risks

- A Host/Gateway identity and revocation system is required.
- Event replay and snapshot retention add storage and testing complexity.
- Long-lived WebSocket/gRPC connections require load-balancer and backpressure
  design.
- A canonical schema and generated binding conformance suite become release
  surfaces.
- The standalone Agent Host extraction is a migration project, not a small
  transport switch.

## Alternatives considered

### Expose the current JSON-RPC stdio endpoint

Rejected. Stdio is a local process boundary, has no remote identity model, and
would expose host internals rather than a reviewed control surface.

### Use gRPC for every link

Rejected. gRPC is appropriate for typed service-to-service communication, but
an interactive Agent also needs browser compatibility, server-initiated
approval/input requests, and easy transport debugging. gRPC remains a required
binding, not the only binding.

### Use JSON-RPC over HTTP only

Rejected as the complete design. It is simple for commands, but a full remote
control session needs an efficient bidirectional path for approvals, input,
events, and cancellation. HTTP/SSE remains the browser binding with explicit
response endpoints.

### Expose Electron Main directly on a public port

Rejected. It expands the desktop attack surface, couples public availability to
the UI process, and gives a network-facing process too much local lifecycle
authority.

### Extend local MCP into a public remote API

Rejected. MCP remains a local, reviewed desktop automation surface. RACP needs
durable Sessions, Turns, cursors, multi-client roles, Gateway identity, and
binding parity that are outside the current MCP contract.

### Restore the historical A2A/Peer stack

Rejected. ADR 0165 removed it because subagent coordination was not a product
requirement. The remote control protocol is client-to-host control, not
subagent messaging.

## Amendment (D376)

Date: 2026-09-10. A pre-implementation review found that the D373 draft was
right about its layering but did not match the desktop it has to wrap, and
required more than v1 can carry. The following changes apply to decisions 3,
4, and 6 above and to the four remote specifications.

1. **One normative v1 binding.** `RACP-WS` is the only normative binding in
   v1. `RACP-HTTP` is the browser profile of the same contract and must ship
   before any browser client. `RACP-GRPC` is reserved, not required, and is
   generated from the contract source if it is ever adopted. Decision 4's
   "MUST share" rule applies to every shipped binding.
2. **One IDL.** The RACP resources are authored as typebox schemas in
   `packages/shared` (frozen decision 28). JSON Schema fixtures,
   documentation tables, and any Protobuf file are generated from them. The
   draft's "JSON normative, proto generated" direction is withdrawn.
3. **Headless Agent Host module first.** Decision 6's Electron facade is
   replaced by `packages/agent-host`, a module with no Electron dependency
   that owns session and turn admission, the per-session turn queue, the
   approval broker, the in-memory event log, and the snapshot builder.
   Desktop IPC, local MCP, and RACP are three callers of that module, so the
   standalone Host extraction moves a module rather than re-splitting Main.
4. **Full local decision vocabulary.** Remote approvals offer `allow-once`,
   `allow-session`, and `deny` for tools and `approve` with an explicit
   permission mode, or `reject`, for Plan and Goal contracts; input requests
   carry the asktool question and skip semantics. A Plan or Goal approval is
   a session-level transition that outlives the submitting turn.
5. **Cursors carry an epoch; deltas are ephemeral.** The cursor is
   `{ epoch, sequence }`. Streaming deltas, tool progress, and activity
   phases are delivered live, never sequenced, never replayed, and never
   counted against the replay window; snapshots carry active items instead.
   The first event log lives in Agent Host memory and a restart starts a new
   epoch; moving it into host-core would need its own ADR.
6. **Host-owned turn queue.** `turn/start` admits immediately or into a
   bounded Host queue that every client, including the local desktop, sees.
   The renderer's in-memory prompt queue is replaced before more than one
   client can control a session. `turn/stop` (graceful) and
   `turn/interrupt` (abort) are separate operations.
7. **Pending requests are Host state.** Rust host-core exposes
   `permissions.pending` so a late-attaching client receives open requests,
   and a remote decision closes the local desktop card.
8. **Remote permission ceiling and approval lifetime.** A remote-initiated
   turn runs under the lower of the session mode and a Host-configured
   ceiling that defaults to `ask`. The local 120-second deny timeout stays
   the default; a Host with remote control enabled may configure a longer
   bounded lifetime for approvals raised while a remote subscriber is
   attached.
9. **Host link relay profile.** The Gateway-to-Host connection multiplexes
   logical client connections so server-initiated approval requests and
   attachment bytes reach the right endpoint without an inbound port; the
   Gateway buffers upload bytes only until the Host confirms them.
10. **Browser authentication profiles.** Browsers cannot set headers on the
    WebSocket and EventSource APIs, so the cookie profile (HttpOnly cookie,
    Origin allowlist, CSRF token) is the browser path and the header profile
    is the non-browser path; URL tokens remain forbidden in both.
11. **Identity source and tenancy.** The Gateway may validate either an
    OIDC/OAuth 2.0 provider or first-party product account tokens; the choice
    is recorded when rollout R3 starts. The first deployment is
    single-tenant; `tenantId` stays in every route and cross-tenant tests
    run once a multi-tenant harness exists.
12. **Catalog additions.** `host/list`, `project/list`, `session/history`,
    host-scope event subscriptions, and `turn/cancel` are added; deferred
    local operations are listed by name so no binding invents a substitute.
