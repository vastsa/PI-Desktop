# ADR 0205: Remote Agent Control Uses a Dedicated Host Boundary

- Status: Accepted for implementation (post-MVP); amended by D374 and D375
- Date: 2026-09-09
- Related: ADR 0004, ADR 0011, ADR 0165, ADR 0203, ADR 0310, D373, D374, D375,
  D385

## Context

Local authority runs through Electron Main, the Node pi sidecar, and Rust
host-core over stdio NDJSON JSON-RPC, with typed IPC to the renderer. Remote
control is a different trust and lifecycle problem: a client may disconnect while
a turn continues, reconnect without missing events, answer host-owned approvals,
and share a session with other clients, which the existing IPC, `host.proxy`, or
host-core JSON-RPC cannot provide without turning the Electron process into a
public backend.

## Decision

1. Electron Main, the Node sidecar, and Rust host-core stay the local authority
   path, and host-core still binds no network port.
2. A logical Agent Host boundary owns sessions, turns, event sequences,
   approvals, attachments, workspace policy, and crash recovery.
3. The PI Remote Agent Control Protocol (RACP) v1 is a transport-neutral semantic
   contract.
4. JSON-RPC over WSS is the primary interactive binding, HTTP/JSON with SSE the
   browser binding, and gRPC over TLS the native and Gateway-to-Host binding, all
   sharing one state machine, cursor, idempotency, authorization, and error
   semantics.
5. Authentication, authorization, routing, rate limiting, revocation, and audit
   belong to a separate Remote Gateway, with the Agent Host connecting outbound so
   a desktop needs no public inbound port.
6. During migration Main may host a development-only facade over existing
   handlers, while production targets a standalone Agent Host process group whose
   wire contract does not change.
7. Remote control stays post-MVP: ADR 0004 still governs the MVP, and this record
   is the follow-up it required.
8. The withdrawn subagent A2A/Peer mechanism is not reused; A2A is a reference for
   binding separation only.

## Consequences

- Local security boundaries stay intact and a running agent is independent of any
  one UI connection, so WebSocket, HTTP/SSE, and gRPC clients share one API.
- A Gateway can route several Hosts without owning workspace secrets or durable
  transcript truth.
- Host and Gateway identity, revocation, event replay retention, long-lived
  connection backpressure, and a binding conformance suite become required work,
  and extracting the standalone Agent Host is a migration project.

## Amendment (D374)

`RACP-WS` is the only normative v1 binding, with `RACP-HTTP` as its browser
profile, `RACP-GRPC` reserved, and one typebox IDL in `packages/shared` generating
all fixtures and tables. A headless `packages/agent-host` module owns admission,
the per-session turn queue, the approval broker, the in-memory event log, and the
snapshot builder, and Desktop IPC, local MCP, and RACP all call into it. Remote
approvals offer `allow-once`, `allow-session`, and `deny`, plus explicit
`approve` / `reject` for Plan and Goal; cursors are `{ epoch, sequence }` with
ephemeral deltas; `turn/start` admits immediately or into one bounded Host queue
with separate `turn/stop` and `turn/interrupt`; pending requests are Host state
surfaced by `permissions.pending`; and a remote turn runs under the lower of the
session mode and a Host permission ceiling.

## Amendment (D375)

Recorded demand orders the milestones: a desktop acting as Remote Client of a
`pi-host` bundle over an SSH tunnel, paired through a bootstrap script that
verifies the published SHA-256, reached through an SSH port forward on the
`RACP-WS` header profile. The desktop adapter presents that Host through the
existing `lib/api.ts`, a remote-host profile adds session, workspace, and terminal
operations, and a reverse tool relay runs user-configured MCP servers and
workspace-free plugin tools on the paired desktop under its own permissions. Turn
queues persist in host-core, remote approvals default to a bounded lifetime while
a subscriber is attached, and outbound messaging becomes the second milestone.

## Amendment (D385)

Remote control is user-local by construction: no project-operated identity,
account, or relay may sit in the path. D375's first-party identity item is
withdrawn, the only client credential is a device token issued by the user's Host
at pairing, PI operates no Gateway, and the Host connects only to the user's SSH
hosts, their configured messaging channels, their providers, and the
checksum-verified `pi-host` download.

## Alternatives

- Expose the current JSON-RPC stdio endpoint or bind Main on a public port:
  rejected because stdio has no remote identity model and a network-facing UI
  process expands the desktop attack surface.
- Use one binding for every link: rejected because gRPC lacks browser and
  server-initiated approval ergonomics while HTTP alone cannot carry efficient
  bidirectional control.
