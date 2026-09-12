# Remote Agent Control Security Specification

- Status: Target specification; post-MVP
- Decision: D373 / ADR 0205, amended by D374 and D375
- Applies to: RACP-WS over the SSH tunnel and any later binding: RACP-HTTP,
  the reserved RACP-GRPC, and the Host link
- Does not weaken: local MCP, host-core, plugin, or provider-secret boundaries

## 1. Security goals

Remote control MUST provide:

1. authenticated user and device identity;
2. authorization scoped to tenant, Host, project, Session, operation, and role;
3. confidentiality and integrity in transit;
4. no direct network access to Rust host-core;
5. host-owned permission and workspace enforcement;
6. revocation and auditability;
7. bounded resource use and safe disconnect behavior;
8. no replay of a completed or previously admitted mutation; and
9. a remote permission ceiling, so a remote controller cannot turn a session
   into unattended execution.

The security design assumes that an Agent can be prompt-injected. A prompt,
tool result, attachment, or model output is untrusted data and MUST NOT grant
an authority that the authenticated principal does not already have.

## 2. Trust zones

```text
┌──────────────────────┐       HTTPS/WSS        ┌─────────────────────┐
│ Remote Client        │ ──────────────────────▶ │ Remote Gateway      │
│ browser/native/CLI   │                         │ identity + routing  │
└──────────────────────┘                         └──────────┬──────────┘
                                                           │ outbound mTLS
                                                           │ Host link
                                                           ▼
                                               ┌─────────────────────────┐
                                               │ Agent Host               │
                                               │ session + policy owner   │
                                               ├──────────┬──────────────┤
                                               │ pi       │ Rust host    │
                                               │ sidecar  │ core         │
                                               └──────────┴──────────────┘
```

| Zone | Trust assumption | Required boundary |
|---|---|---|
| Remote Client | Authenticated but UI and prompt data are untrusted | Scoped session or bearer credential; no secret authority by default |
| Gateway | User-hosted relay, routable and exposed | Authn, authz, rate limits, audit, transient buffers only, no raw host RPC |
| Agent Host | Trusted local authority beside the workspace | mTLS/device identity, signed route context, host policy, remote permission ceiling |
| Node sidecar | Agent runtime, not policy owner | Main/Host proxy allowlist |
| Rust host-core | Workspace, storage, tool, permission, and secret authority | stdio only; no public listener |

## 3. Identity and enrollment

### 3.1 Client to Gateway

The production Gateway MUST validate an established identity before routing.
D385 makes remote control user-local by construction. No project-operated
identity or account service is in the path: the only credential a client ever
holds is a device token issued by the user's own Host at pairing (§3.4). A
Gateway, if a user runs one, is self-hosted on the user's infrastructure and
admits clients with those same Host-issued device credentials; it validates
the token's Host id, expiry, and revocation state before routing. OIDC
federation and the pi-backend account service are out of scope for remote
control, and refresh tokens do not exist in this model.

Because a browser cannot set request headers on the `WebSocket` and
`EventSource` APIs, the Gateway offers two authentication profiles:

- **Header profile** for non-browser clients: the access token is sent in the
  `Authorization` header of every request and of the WebSocket upgrade.
- **Cookie profile** for browser clients: after device pairing the self-hosted Gateway or the Host issues an
  `HttpOnly`, `Secure`, `SameSite=Lax` or stricter session cookie; the
  WebSocket upgrade and the SSE request are authorized by that cookie plus the
  per-tenant Origin allowlist, and every mutation carries a CSRF token issued
  with the session. A browser client MAY instead stream events through `fetch`
  with the header profile.

In both profiles access tokens MUST NOT be placed in query strings, WebSocket
URLs, SSE URLs, attachment names, or event payloads. Bearer-only APIs still
validate Origin for browser requests.

The Gateway and the cookie profile belong to the unscheduled Gateway and
browser milestones (D375). The first remote topology uses the header profile
with a device token obtained through the SSH bootstrap pairing in §3.4.

For the first trusted-device prototype, a one-time pairing code MAY bootstrap
the identity link. It MUST be short-lived, single-use, displayed out of band,
and exchanged over TLS. A pairing code MUST NOT become a long-lived API token.

### 3.2 Agent Host to Gateway

The Agent Host MUST open the production connection outbound. The Host link
uses mutual TLS with a per-host identity certificate or an equivalent signed
device credential.

- Enrollment credentials are one-time and expire after the enrollment window.
- Host credentials are scoped to one tenant and Host identity.
- The Gateway rejects a certificate or device credential after revocation.
- Credentials rotate without exposing provider secrets to the Gateway.
- The Host rejects a Gateway connection whose server identity is not pinned to
  the configured product trust roots.
- The Host never accepts an unauthenticated inbound control socket.
- The Host link authenticates the Gateway only. User authority on a relayed
  connection comes solely from the per-connection route context in §3.3.

Direct LAN or development connections still use TLS and an expiring device
token. Plain `ws://`, plain HTTP, and static shared tokens in URLs are not
supported.

### 3.3 Host capability context

After the Gateway authenticates a user, it issues a short-lived signed route
context for each logical client connection:

```ts
type HostRouteContext = {
  tenantId: string
  hostId: string
  subject: string
  clientConnectionId: string
  sessionScopes: string[]
  roles: string[]
  issuedAt: string
  expiresAt: string
  tokenId: string
}
```

The Agent Host verifies the signature, audience, Host id, expiry, and session
scope before executing any mutation. The Gateway's transport connection is not
itself authorization for a session, and a route context for one
`clientConnectionId` cannot be replayed on another.

### 3.4 SSH bootstrap pairing (first remote topology)

The desktop bootstraps a `pi-host` on a remote machine over the user's own
SSH session (`02-architecture/05-remote-agent-control.md` §5.2). The trust
argument is that an SSH login already proves shell access to that machine;
pairing only binds a desktop device to the Host it started.

- The pairing token is generated by the Host at start, is single-use, expires
  within the bootstrap window, and travels only over the SSH channel; it is
  never written to a world-readable file or a URL.
- The desktop exchanges it once, over the forwarded loopback port, for a
  device token that it stores in its secure storage; the Host records the
  device as `owner` of that Host.
- The Host binds loopback only and accepts a device token only from a
  loopback peer; a non-loopback bind requires TLS and the same device token.
- The bootstrap script, uploaded over SSH, downloads the `pi-host` bundle for
  the remote platform at the desktop's version from GitHub Releases, verifies
  the SHA-256 published with the release, and installs it under the user's
  home; the desktop never uploads executable bytes itself. A machine without
  outbound access to GitHub cannot be bootstrapped in the first version.
- Revoking the device token on the Host, or removing the Host from the
  desktop, ends the pairing; a new pairing needs a new SSH bootstrap.
- Provider configuration for the remote Host is written over the SSH channel
  by the bootstrap step as Host-local configuration; it never crosses RACP.

## 4. Authorization model

### 4.1 Role matrix

| Operation | Viewer | Controller | Approver | Owner |
|---|---:|---:|---:|---:|
| List/get visible hosts, projects, and sessions | yes | yes | yes | yes |
| Subscribe to session or host events | yes | yes | yes | yes |
| Read session history | yes | yes | yes | yes |
| Create/attach as viewer | yes | yes | yes | yes |
| Start or queue a turn | no | yes | optional | yes |
| Stop, interrupt, or cancel a session turn | no | yes | optional | yes |
| Resolve tool approval (`allow-once`, `deny`) | no | no by default | yes | yes |
| Resolve tool approval with `allow-session` | no | no | policy | yes |
| Resolve Plan/Goal approval with permission mode | no | no by default | explicit policy | yes |
| Answer an input request | no | yes | optional | yes |
| Upload an attachment | no | yes | optional | yes |
| Revoke membership | no | no | no | yes |
| Archive a session | no | no | no | yes |
| Open or use a session terminal | no | policy | policy | yes |
| Advertise relayed tools | no | no | no | yes |

Role checks are necessary but not sufficient. The Host MUST additionally check:

- the Session belongs to the requested tenant and Host;
- the principal is allowed to use the Session's project;
- the operation is legal in the Session state;
- the durable permission/mode policy allows the proposed action;
- the remote permission ceiling has been applied to the turn; and
- the request's expected revision and idempotency key are valid.

### 4.2 No privilege escalation through protocol fields

The following client fields are advisory only or forbidden:

- `permissionMode` cannot upgrade a durable Session policy; the only accepted
  permission-mode field is the explicit selection on a Plan/Goal `approve`,
  and it is validated against `allowedPermissionModes`;
- `admission: "queue"` cannot bypass single-turn execution; it only places a
  bounded, cancelable entry in the Host queue;
- `workspaceRoot` cannot replace a Host-owned project binding;
- `toolName` cannot select a tool outside the Host catalog;
- `confirm` cannot replace an approval request or create an approval result;
- `providerApiKey`, secret values, and secret references cannot be supplied in
  a turn payload; and
- a client cannot claim another `principal`, `agentName`, `connectionId`, or
  `clientConnectionId`.

The Host chooses the effective model/provider configuration from its own
session and provider state. Remote control does not become a credential relay.

### 4.3 Remote permission ceiling

A turn started by a remote principal runs under the lower of the Session's
durable permission mode and the Host's configured `remoteMaxPermissionMode`,
ordered `ask` < `accept-edits` < `auto`. The default ceiling is `ask`. The
Host operator may raise it; a principal may exceed it only when the principal
holds `approver` and Host policy allows approvers to use the session's own
mode. The applied value is reported as `effectivePermissionMode` and never
changes the durable session mode.

The ceiling applies to Gateway-routed principals. A desktop device paired
through the SSH bootstrap (§3.4) holds `owner` on that Host and is exempt:
an SSH login already grants shell access to the machine, so a ceiling would
withhold nothing. Its turns report the session's own mode as
`effectivePermissionMode`. The Host policy `applyCeilingToPairedDevices`
(default off) re-applies the ceiling to paired devices for an operator who
wants every remote turn to start at `ask`.

`allow-session` is offered to a remote approver only when Host policy allows
remote session grants; otherwise the request's `allowedDecisions` omit it. A
session grant made remotely is the same by-tool-name grant as a local one
(frozen decision 18) and ends with the Session.

## 5. Network and transport protections

### 5.1 TLS

- Public HTTP, SSE, and WebSocket endpoints MUST use TLS 1.2 or newer; TLS
  1.3 is preferred. A reserved gRPC binding inherits the same rule.
- A `pi-host` bound to loopback and reached through an SSH port forward MAY
  accept plain `ws://` when both the bind address and the peer address are
  loopback and a valid device token is presented; the SSH channel provides
  confidentiality, matching the loopback rule of ADR 0203. Any non-loopback
  bind requires TLS.
- The production Host link MUST use mutual TLS or an equivalent device-bound
  authenticated channel.
- Certificate validation MUST include hostname or service identity validation;
  disabling verification is not a development shortcut supported by the
  product.
- WebSocket upgrade credentials, header or cookie, are validated before
  accepting the connection.

### 5.2 Origin and cross-site controls

- The Gateway maintains an explicit browser Origin allowlist per tenant and
  checks it on every WebSocket upgrade and SSE request from a browser.
- Local-only endpoints bind loopback and validate loopback Origin as required
  by ADR 0203.
- Cookie-profile sessions use `SameSite` protection and a CSRF token on every
  mutation, including mutations sent over an already-open WebSocket.
- A bearer token in a URL is always rejected.
- CORS exposes only the required methods, headers, and response types.

### 5.3 Request binding and replay protection

Every mutation carries a principal-bound idempotency key. The Host stores the
key and result for at least the active turn lifetime and rejects reuse with
different payload bytes. A Gateway retry MUST preserve the key and trace
context.

Requests with an expired route context, stale session revision, or revoked
connection fail before they reach the Agent runtime.

## 6. Workspace, file, and attachment security

1. A remote request identifies a Session, not an arbitrary filesystem root.
2. The Host resolves every tool path against that Session's durable project or
   scratch root.
3. Remote clients send attachment bytes or opaque attachment ids, never local
   absolute paths or `file://` URLs.
4. The Host validates declared size, actual size, MIME policy, SHA-256, and
   expiration before a turn can reference an attachment.
5. Attachment storage is private to the owning tenant, Host, and Session.
6. Uploads are not executable and are not automatically added to a tool root.
7. Gateway URL fetches are not accepted as an attachment source, preventing
   SSRF through a remote-control request.
8. Workspace reads and writes continue to use the current host sandbox,
   ignore rules, path checks, and permission policy.
9. Behind a Gateway the upload target is served by the Gateway. The Gateway
   enforces only the size bound, relays the bytes to the Host in bounded
   chunks, deletes its copy when `attachment/complete` succeeds or the upload
   expires, and never inspects, persists, or serves those bytes elsewhere.

## 7. Tool and approval security

Remote control MUST use the existing host-owned tool execution path. It MUST
NOT expose:

- raw `host.proxy` calls;
- raw Rust host-core methods;
- generic Electron IPC invocation;
- provider secret get/set/delete methods;
- arbitrary process spawning; or
- a remote equivalent of a disabled permission mode.

Approval requests contain a bounded, redacted summary. The client submits a
decision for a live request; it does not submit a tool invocation to be
executed after approval. The decision vocabulary is the local one:
`allow-once`, `allow-session`, and `deny` for tools; `approve` with an
explicit permission mode, or `reject`, for Plan and Goal contracts. The Host
verifies request id, Session id, turn id, principal role, expiry, allowed
decision, permission-mode selection, and current state in one operation.

Pending requests are Host state. Rust host-core keeps the pending permission
table and its timer; the Agent Host reads it through `permissions.pending`
so a late-attaching client receives open requests. That read is redacted the
same way as the request event and never returns tool arguments beyond the
bounded preview.

Approval lifetime is Host policy. The local default remains 120 seconds then
deny (frozen decision 17). While a remote subscriber is attached the default
is 30 minutes (D375); the operator may shorten or lengthen it within a bound,
the blocked tool waits for that lifetime unless a local or remote decision
arrives earlier, and a client disconnect never extends it.

An approval response that arrives after disconnect, expiry, abort, crash, or
turn completion is a no-op or a structured stale/expired error. It never
restarts the turn. The first valid decision wins across local and remote
clients; later valid responses receive the stored result.

A remote session's catalog contains the remote Host's tools plus the tools
the paired desktop advertised for relay: its user-configured MCP servers and
plugin tools that do not require the session workspace. A relayed tool
executes on the desktop under the desktop's own plugin permissions and
confirmation rules, never on the Host and never against the remote workspace;
the Host's permission decision precedes the relay request, the Host sends only
the Agent's arguments and never a secret, and a lost relay connection fails
the tool without interrupting the turn. Provider secrets never cross RACP in
either direction; the remote Host's providers are configured over the SSH
bootstrap channel (§3.4).

A session terminal is a shell on the Host machine running as the `pi-host`
user with the session root as its working directory. Only the SSH-paired
owner device or a principal holding the explicit `terminal` scope may open
one; Gateway-routed principals need that scope from policy. Terminal output
is ephemeral and recoverable only from the terminal's bounded replay ring.

## 8. Gateway and tenant isolation

The Gateway milestone is unscheduled (D375). These rules bind when it is
scheduled and are retained so the contract does not drift.

- Every route is keyed by `(tenantId, hostId, sessionId)`.
- A user-local deployment has exactly one tenant, the Host itself; PI never
  operates a shared Gateway (D385).
- The first deployment is single-tenant. Routes already carry `tenantId` so a
  second tenant is an operational change, not a protocol change; cross-tenant
  isolation tests run once a multi-tenant harness exists.
- A client cannot enumerate Host or Session ids outside its signed scope.
- Gateway caches contain opaque ids and routing metadata, not provider secrets.
- A Host reconnect replaces the old connection only after identity and tenant
  match; stale links are closed.
- A tenant's rate limits and event queues are independent of other tenants.
- Logs and metrics carry tenant/host/session identifiers only where the
  retention policy permits; prompt and tool content is excluded by default.

## 9. Abuse controls and resource bounds

The Gateway and Host enforce the lower of their configured limits:

| Resource | Initial target |
|---|---:|
| Control requests per principal | 120/minute |
| Turn starts per Session | 20/minute |
| Queued turns per Session | 8 |
| Concurrent clients per Host | 16 |
| Concurrent subscriptions per connection | 8 |
| Request/event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Attachment | 50 MiB |
| In-flight attachment uploads per principal | 4 |
| Event send queue | 4 MiB or 1,000 durable events |
| Open terminals per Session | 2 |

Rate-limit responses include a retry hint but never disclose another tenant's
quota. Slow clients lose ephemeral events first and are disconnected with a
resumable cursor before a durable event is lost. The Host never blocks the
Agent turn indefinitely on a remote client that stopped reading.

## 10. Audit and observability

Every remote control mutation produces a structured audit record containing:

- `traceId`, `connectionId`, `clientConnectionId`, `principal`, `tenantId`,
  `hostId`;
- Session and turn ids;
- operation and outcome, including the admission mode and
  `effectivePermissionMode` of a started turn;
- authorization decision and role;
- idempotency key hash, not the raw key;
- event epoch and sequence range, when applicable; and
- error code, or approval decision with the selected permission mode.

Audit records MUST NOT contain provider credentials, raw prompt text, raw tool
arguments, raw tool output, attachment bytes, or approval secrets by default.
The runtime logger may record bounded redacted summaries under the existing
redaction policy.

Metrics SHOULD cover connection count, reconnects, authentication failures,
authorization failures, event lag, replay/resync counts, epoch changes, queue
depth, turn admission latency, approval latency, queue drops, and Host
availability.

Trace propagation uses W3C `traceparent` where the selected transport supports
it. A Gateway MUST preserve the trace id across the Host link.

## 11. Revocation and incident response

The Gateway MUST be able to revoke:

- a user session;
- a Host device;
- a client connection;
- a Session membership; and
- a pending attachment or upload target.

Revocation closes active connections, prevents new mutations, cancels queued
turns the revoked principal submitted, and leaves the Agent Host's local turn
policy unchanged. A running turn is interrupted only when the revoked scope or
incident policy explicitly requires it; revocation must not silently replay or
roll back a completed turn.

Provider credential rotation remains an Agent Host operation. Remote clients
cannot use the control protocol to export, test, or replace a secret unless a
separate, explicitly specified credential-management capability is added.

## 12. Security acceptance gates

1. Plain HTTP and `ws://` are rejected outside an explicitly isolated local
   test harness.
2. Rust host-core has no public listener and cannot be addressed by a remote
   client.
3. A viewer cannot start a turn or resolve an approval.
4. A controller cannot select an unauthorized Session, workspace, tool, model,
   permission mode, or provider secret.
5. A prompt-injected tool result cannot change the authenticated principal or
   role.
6. Duplicate mutation keys cannot create duplicate turns or approvals.
7. An expired/revoked credential cannot resume a connection or upload bytes.
8. Cross-tenant Host, Session, event, attachment, and audit access is denied
   once a multi-tenant harness exists.
9. Event replay never crosses a Session or principal scope.
10. Gateway and Host logs contain no provider secrets or unredacted tool data.
11. Slow clients cannot exhaust Host memory or stall an Agent turn.
12. Host crash, Gateway reconnect, and client reconnect do not replay an
    already-admitted execution.
13. A remote-initiated turn never reports an `effectivePermissionMode` above
    the configured ceiling, and `allow-session` is absent unless policy
    allows it.
14. Browser WebSocket and SSE connections succeed only on the cookie profile
    with Origin and CSRF checks, or on the header profile through `fetch`;
    URL tokens fail in both. Applies when the browser milestone is scheduled.
15. A relayed server-initiated approval request is answered exactly once, and
    the answer reaches only the Host that raised it. Applies when the Gateway
    milestone is scheduled.
16. A `pi-host` bound to loopback accepts only loopback peers with a valid
    device token; a non-loopback bind without TLS fails to start.
17. A pairing token is single-use, arrives only over the SSH channel, and
    cannot be exchanged twice or from a non-loopback peer.
18. A remote session exposes only the remote Host's tool catalog; desktop
    plugin tools and desktop MCP servers never execute against a remote
    workspace, and provider secrets never cross RACP.
19. A relayed tool never executes on the Host and never receives a Host
    secret; the Host's approval precedes the relay request; a lost relay
    connection fails the tool without interrupting the turn.
20. A session terminal opens only for the SSH-paired owner or a principal
    with the `terminal` scope, with its working directory inside the session
    root.

## 13. Amendment history

D374 (2026-09-10) added the browser cookie/header authentication profiles,
the two accepted identity sources, the remote permission ceiling, the local
decision vocabulary, the remote approval lifetime policy, the Host link and
Gateway attachment relay rules, the single-tenant-first clause, and gates
13–15.

D375 (2026-09-10) added the SSH bootstrap pairing (§3.4), the loopback rule
for `pi-host` behind an SSH port forward, the ceiling exemption for
SSH-paired owner devices, the remote tool-catalog and provider-configuration
rules, gates 16–18, and marked the Gateway and cookie-profile clauses as
belonging to unscheduled milestones.

The D375 design-gate answers, recorded the same day, fixed the identity
source to the PI account service, the GitHub Releases download for
`pi-host`, the relay and terminal rules with gates 19–20, the 30-minute
remote approval lifetime, and the `applyCeilingToPairedDevices` policy.

D385 (2026-09-10) withdrew the first-party identity source: remote control
is user-local by construction, every credential is issued by the user's own
Host, and any Gateway is self-hosted and admits clients with those device
credentials.
