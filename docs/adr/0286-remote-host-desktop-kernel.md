# ADR 0286: Remote-host desktop kernel

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D449
- Related: ADR 0205 (D373 / D374 / D375), ADR 0285 (D448),
  `03-runtime/19-remote-agent-control-protocol.md` §3.4

## Context

ADR 0285 delivered the `RACP-WS` transport and pairing on both ends, but the
desktop still lacked the kernel that lets the renderer treat a remote session
exactly like a local one (spec §3.4). The renderer must not learn the transport,
`index.ts` is pinned at 1500 LOC by the architecture gate, and the desktop cannot
open a network listener, so every outbound flow goes through the RACP client to a
paired host.

## Decision

1. **A single interception seam: `backend-router.ts`.** The router is consulted
   from `ipc/register.ts`'s `handle()` wrapper and returns `ROUTE_LOCAL` when no
   `RemoteBackend` is registered for the call's session id, so a session turns
   remote only once its `remote:<hostKey>:<hostSessionId>` id is registered.
2. **A stateless per-request session id.** `sessionIdForCall` recovers the
   session from the first positional argument, `first.sessionId`, `first.id`, or
   the `<remoteSessionId>#racp-approval:<hostApprovalId>` requestId used by tool
   approval, so approval routing needs no correlation map.
3. **A transport-agnostic backend: `remote-backend.ts`.** One instance per paired
   host serves all of its sessions, translating 17 channels into RACP requests
   and reshaping results into the shapes `api.ts` already returns; channels the
   remote profile does not cover report false from `handles()` or throw
   `CAPABILITY_UNAVAILABLE` and fall back to the local handler.
4. **Two synthesis rules to reconcile schema mismatches without a round-trip.**
   Tool approval encodes the session into its requestId, and `plansResolve`
   synthesizes a minimal `PlanProposal` that the follow-up `session.changed` event
   replaces with the authoritative snapshot.
5. **A pure event bridge: `remote-event-bridge.ts`.** RACP events become
   `IPC.event.agentMessage` / `IPC.event.sessionsChanged`, forwarding the
   `AgentEvent` in `payload.event`, turning `tool` kind `approval.requested` into
   `tool_permission_request`, dropping plan and goal approvals in favour of
   `planning_state`, and signalling `session.created` / `archived`.
6. **A coordinator per paired host: `remote-host-connection.ts`.** Its `open()`
   sequence of attach listener, subscribe host scope, `session/list`,
   per-session subscribes closes the create race, and `close()` is idempotent and
   safe before `open()`.
7. **A `RemoteHostClient` seam with multi-listener `subscribe`.**
   `racp-remote-host-client.ts` is the only remote module importing
   `@pi-desktop/racp`; it fans the client's single callback out to every listener
   and swallows listener throws.
8. **Encrypted-at-rest registry: `remote-host-registry.ts`.** Paired hosts live in
   `<dataDir>/remote-hosts.json` with device tokens encrypted through
   `safeStorage` behind an `EncryptionPort`, `upsert` refuses to write when the
   keychain is unavailable, and `list` drops records it cannot decrypt.
9. **Boot hook: `bootstrap/remote-hosts.ts`.** It opens one adapter and one
   connection per registered host, logging and skipping a failing host, with an
   empty registry as a full no-op; `startup.ts` opens in the background and
   `shutdown.ts` closes paired sockets before host-core is disposed.

## Consequences

- Adding an encrypted host entry to `<dataDir>/remote-hosts.json` is enough for
  the desktop to connect and stream events into the existing renderer.
- With no pairing the kernel is a zero-behavior change: `route()` returns
  `ROUTE_LOCAL` for every call and existing handlers run unchanged.
- `apps/desktop` gains an additive `@pi-desktop/racp` dependency, `index.ts` stays
  at 1500 LOC, and later stages plug into the router, bridge, and registry seams.

## Alternatives considered

- Route from each per-domain IPC handler: every handler would duplicate the same
  dispatch and every new channel would need wiring twice.
- Bake remote knowledge into the renderer: a `remote:` prefix in `api.ts` forces
  every store slice to know the transport, which spec §3.4 forbids.
- A plain-text registry: a compromised backup would hand out device tokens that
  authenticate against a real `pi-host`.
