# ADR 0285: `RACP-WS` transport in `packages/racp`

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D448
- Related: ADR 0205 (D373 / D374 / D375), ADR 0284 (D447),
  `03-runtime/19-remote-agent-control-protocol.md` §3, §4, §8, §11.1, §14a,
  `05-security/02-remote-control-security.md` §3.4, §5.1

## Context

R0 froze the RACP contract as typebox schemas and R1 delivered the headless
Agent Host module. Nothing yet moved a JSON-RPC frame between two processes: the
module was only driven by Electron IPC.

## Decision

1. **A new workspace package, `packages/racp`, holds both ends of the binding.**
   It depends on `shared`, `agent-host`, and `ws` only.
2. **The server is a thin catalog over the module.** Every operation in
   `RACP_OPERATIONS` is dispatched through the catalog's role rule; the session,
   turn, event, approval, and input operations call the Agent Host module
   directly; the remote-host profile (session catalog mutations, projects,
   workspace reads, terminals) goes through the `RacpHostOperations` interface
   that `pi-host` implements.
3. **Header-profile authentication with Host-issued device tokens.** The upgrade
   request must carry `Authorization: Bearer`; a token in the URL, a
   non-loopback peer, a wrong path, a missing subprotocol, or a binary frame is
   refused before any RPC.
4. **Three catalog additions, all in the remote-host profile:**
   `connection/pair`, `project/register`, and `project/browse`.
5. **Reconnect is the client's, replay is the Host's.** The client reconnects
   with bounded backoff, rejects the dropped connection's in-flight calls with
   `HOST_DISCONNECTED`, and never re-sends them; it remembers the last durable
   cursor per session so the caller resubscribes with `after`.
6. **`StartTurnParams.input.userMessageId`** is threaded from `turn/start`'s
   `input.messageId` through the queue record to the runtime, so a remote client
   keeps its optimistic user row id (D288) the way the renderer does over IPC.

## Consequences

- `pi-host` composes `RacpServer` + `bindRacpWebSocket` over the module and
  `RuntimeService` (ADR 0284); the desktop adapter composes `RacpClient` +
  `wsClientTransport`.
- The conformance behaviors of spec §14 that do not need a machine boundary
  (handshake, authorization, idempotency, queue ordering, approval decisions,
  cursor replay, eviction, epoch change, slow clients, reconnect without
  duplicate execution) are tests in `packages/racp` and run without Electron.
- Attachments and the tool relay are advertised as unavailable (`attachments:
  false`, `toolRelay: false`) and their operations fail with
  `CAPABILITY_UNAVAILABLE`; they land with their own change.
- The server bind refuses a non-loopback address outright rather than offering a
  TLS path; a non-loopback deployment is a later decision.

## Alternatives considered

- **Run RACP inside Electron main first (development loopback endpoint).**
  Rejected for this change: the only scheduled client is the desktop, and the
  first server is `pi-host`; a desktop-side listener would add a network surface
  with no consumer.
- **Cookie profile alongside the header profile.** Rejected: it belongs to the
  unscheduled browser milestone (D375).
- **Static shared secret instead of pairing.** Rejected by security §3.2 and
  §3.4: a pairing token must be single-use and become a per-device credential
  that can be revoked on its own.
