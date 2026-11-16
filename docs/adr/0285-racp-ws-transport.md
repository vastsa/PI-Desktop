# ADR 0285: `RACP-WS` transport in `packages/racp`

- Status: Accepted for implementation
- Date: 2026-09-18
- Related: D373, D374, D375, D447, D448, ADR 0205, ADR 0284

## Context

R0 froze the RACP contract as typebox schemas and R1 delivered the headless Agent Host
module, but nothing moved a JSON-RPC frame between processes: R2 needs the normative
`RACP-WS` binding on both sides of an SSH tunnel — a server the `pi-host` bundle binds on
loopback and a client Electron main runs — plus the device-token pairing of security §3.4.

## Decision

1. A new workspace package, `packages/racp`, holds both ends of the binding and depends on
   `shared`, `agent-host`, and `ws` only; `RacpServer` and `RacpClient` take an injected
   transport, so the same code runs over `ws` in production and an in-memory pair in tests,
   with `bindRacpWebSocket` and `wsClientTransport` as the adapters.
2. The server is a thin catalog over the module: every operation in `RACP_OPERATIONS`
   dispatches through the catalog's role rule, core session, turn, event, approval, and input
   operations call the module directly, and the remote-host profile goes through
   `RacpHostOperations`, which `pi-host` implements.
3. Authentication is a header profile with Host-issued device tokens: the upgrade request
   must carry `Authorization: Bearer`, and a token in the URL, non-loopback peer, wrong path,
   missing subprotocol, or binary frame is refused before any RPC; `pdt1.` device and `ppt1.`
   pairing tokens are stored as SHA-256 hashes and compared in constant time, and a pairing
   token is single-use, expiring, and authenticates only `connection/pair`, which mints an
   `owner` device.
4. Three catalog additions, all in the remote-host profile — `connection/pair`,
   `project/register`, and `project/browse` — come with the shared error codes
   `PAIRING_FAILED`, `PAIRING_TOKEN_EXPIRED`, `CAPABILITY_UNAVAILABLE`,
   `REMOTE_PATH_NOT_FOUND`, `REMOTE_PATH_FORBIDDEN`, `HOST_DISCONNECTED`,
   `HOST_BOOTSTRAP_FAILED`, `HOST_VERSION_MISMATCH`, `REMOTE_AUTH_FAILED`,
   `REMOTE_CONNECTION_FAILED`, and `REMOTE_FORWARD_FAILED`; `connection/initialize` gains
   `server.hostId`.
5. Reconnect is the client's and replay is the Host's: the client reconnects with bounded
   backoff, rejects the dropped connection's in-flight calls with `HOST_DISCONNECTED`,
   never re-sends them, and remembers the last durable cursor per session so the caller
   resubscribes with `after`, while the Host answers with a replay or a snapshot plus
   `resyncReason` and a dropped connection releases its subscriptions without touching a
   turn.
6. `StartTurnParams.input.userMessageId` is threaded from `turn/start`'s `input.messageId`
   through the queue record to the runtime, so a remote client keeps its optimistic user row
   id (D288).

## Consequences

- `pi-host` composes `RacpServer` + `bindRacpWebSocket` over the module and
  `RuntimeService` (ADR 0284); the desktop adapter composes `RacpClient` +
  `wsClientTransport`.
- Attachments and the tool relay are advertised as unavailable (`attachments: false`,
  `toolRelay: false`) and fail with `CAPABILITY_UNAVAILABLE` until their own change.
- The server bind refuses a non-loopback address rather than offering a TLS path.

## Alternatives

- Run RACP inside Electron main first: the only scheduled client is the desktop, so a
  desktop listener would add network surface with no consumer.
- Static shared secret instead of pairing: security §3.2 and §3.4 require a single-use
  token that becomes a revocable per-device credential.
