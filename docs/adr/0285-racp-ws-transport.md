# ADR 0285: `RACP-WS` transport in `packages/racp`

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D448
- Related: ADR 0205 (D373 / D374 / D375), ADR 0284 (D447),
  `03-runtime/19-remote-agent-control-protocol.md` §3, §4, §8, §11.1, §14a,
  `05-security/02-remote-control-security.md` §3.4, §5.1

## Context

R0 froze the RACP contract as typebox schemas and R1 delivered the headless
Agent Host module. Nothing yet moved a JSON-RPC frame between two processes:
the module was only driven by Electron IPC. R2 needs the normative `RACP-WS`
binding on both sides of an SSH tunnel — a server that the `pi-host` bundle
binds on loopback and a client that Electron main runs — and it needs the
device-token pairing of security §3.4, which the security spec described but
no code implemented.

## Decision

1. **A new workspace package, `packages/racp`, holds both ends of the
   binding.** It depends on `shared`, `agent-host`, and `ws` only. The server
   core (`RacpServer`) and the client core (`RacpClient`) take an injected
   transport, so the same code runs over `ws` in production and over an
   in-memory pair in tests; `bindRacpWebSocket` and `wsClientTransport` are
   the `ws` adapters.
2. **The server is a thin catalog over the module.** Every operation in
   `RACP_OPERATIONS` is dispatched through the catalog's role rule; the
   session, turn, event, approval, and input operations call the Agent Host
   module directly; the remote-host profile (session catalog mutations,
   projects, workspace reads, terminals) goes through the `RacpHostOperations`
   interface that `pi-host` implements. The server never touches host-core
   RPC, a filesystem, or a pty (security §7).
3. **Header-profile authentication with Host-issued device tokens.** The
   upgrade request must carry `Authorization: Bearer`; a token in the URL, a
   non-loopback peer, a wrong path, a missing subprotocol, or a binary frame
   is refused before any RPC. Tokens are `pdt1.` (device) or `ppt1.` (pairing),
   stored as SHA-256 hashes, and compared in constant time. A pairing token is
   single-use and expiring; it authenticates an unprivileged connection that
   may only call `connection/pair`, which mints an `owner` device.
4. **Three catalog additions, all in the remote-host profile:**
   `connection/pair`, `project/register`, and `project/browse`. Six codes
   join the shared error registry: `PAIRING_FAILED`,
   `PAIRING_TOKEN_EXPIRED`, `CAPABILITY_UNAVAILABLE`, `REMOTE_PATH_NOT_FOUND`,
   `REMOTE_PATH_FORBIDDEN`, and the desktop-side connection codes
   `HOST_DISCONNECTED`, `HOST_BOOTSTRAP_FAILED`, `HOST_VERSION_MISMATCH`,
   `REMOTE_AUTH_FAILED`, `REMOTE_CONNECTION_FAILED`, `REMOTE_FORWARD_FAILED`.
   `connection/initialize` gains `server.hostId`. The binding details that the
   protocol left open are recorded in spec §14a.
5. **Reconnect is the client's, replay is the Host's.** The client reconnects
   with bounded backoff, rejects the dropped connection's in-flight calls with
   `HOST_DISCONNECTED`, and never re-sends them; it remembers the last durable
   cursor per session so the caller resubscribes with `after`. The Host
   answers with a replay, or with a snapshot and a `resyncReason`, exactly as
   the module already did for IPC. A dropped connection releases its
   subscriptions and terminal attachments and touches no turn.
6. **`StartTurnParams.input.userMessageId`** is threaded from
   `turn/start`'s `input.messageId` through the queue record to the runtime,
   so a remote client keeps its optimistic user row id (D288) the way the
   renderer does over IPC.

## Consequences

- `pi-host` composes `RacpServer` + `bindRacpWebSocket` over the module and
  `RuntimeService` (ADR 0284); the desktop adapter composes `RacpClient` +
  `wsClientTransport`.
- The conformance behaviors of spec §14 that do not need a machine boundary
  (handshake, authorization, idempotency, queue ordering, approval decisions,
  cursor replay, eviction, epoch change, slow clients, reconnect without
  duplicate execution) are tests in `packages/racp` and run without Electron.
- Attachments and the tool relay are advertised as unavailable
  (`attachments: false`, `toolRelay: false`) and their operations fail with
  `CAPABILITY_UNAVAILABLE`; they land with their own change.
- The server bind refuses a non-loopback address outright rather than
  offering a TLS path; a non-loopback deployment is a later decision.

## Alternatives considered

- **Run RACP inside Electron main first (development loopback endpoint).**
  Rejected for this change: the only scheduled client is the desktop, and the
  first server is `pi-host`; a desktop-side listener would add a network
  surface with no consumer.
- **Cookie profile alongside the header profile.** Rejected: it belongs to
  the unscheduled browser milestone (D375).
- **Static shared secret instead of pairing.** Rejected by security §3.2 and
  §3.4: a pairing token must be single-use and become a per-device credential
  that can be revoked on its own.
