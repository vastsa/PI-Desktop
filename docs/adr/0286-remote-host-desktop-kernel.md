# ADR 0286: Remote-host desktop kernel

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D449
- Related: ADR 0205 (D373 / D374 / D375), ADR 0285 (D448),
  `03-runtime/19-remote-agent-control-protocol.md` §3.4, §4, §5, §7, §8,
  `05-security/02-remote-control-security.md` §3.4,
  `06-delivery/07-remote-control-rollout.md` §2 R2

## Context

ADR 0285 delivered the `RACP-WS` transport and pairing on both ends. The
`pi-host` bundle now binds a real WebSocket server on loopback and speaks the
frozen contract; a `RacpClient` in `packages/racp` reaches it with header
authentication.

- The renderer must never learn the transport.
- The frozen architecture pins `apps/desktop/electron/main/index.ts` at 1500 LOC
  (`scripts/check-architecture.mjs`).
- The desktop cannot open a network listener of its own (security §7).

## Decision

The desktop-side R2 kernel is five modules and one boot hook, all under
`apps/desktop/electron/main/remote/` (module state) and
`apps/desktop/electron/main/bootstrap/` (boot state), and one new workspace
dependency (`@pi-desktop/racp`).

1. **A single interception seam: `backend-router.ts`.** The router is consulted
   from `ipc/register.ts`'s `handle()` wrapper; it returns the sentinel
   `ROUTE_LOCAL` when no `RemoteBackend` is registered for the call's session
   id, and the local handler runs unchanged.

2. **A stateless per-request session id.** `sessionIdForCall` recovers the
   session from either the first positional argument, `first.sessionId`,
   `first.id` (`sessionGet` uses this shape), or a
   `<remoteSessionId>#racp-approval:<hostApprovalId>` requestId used by tool
   approval.

3. **A transport-agnostic backend: `remote-backend.ts`.** One
   `createRemoteBackend({hostKey, client, ...})` instance serves every session
   of a paired host — the router registers it under each id.

4. **Two synthesis rules to reconcile schema mismatches without a round-trip.**
   - Tool-approval resolution has no session id in its wire payload, so the
     backend encodes `<remoteSessionId>#racp-approval:<hostApprovalId>` into the
     requestId (§ Decision 2) and decodes it back for `approval/respond`.
   - `plansResolve` returns `PlanResolutionResult` to the renderer, but RACP's
     `approval/respond` returns only `RacpApprovalResult`.

5. **A pure event bridge: `remote-event-bridge.ts`.** RACP events are translated
   into `IPC.event.agentMessage` / `IPC.event.sessionsChanged` for the renderer.

6. **A coordinator per paired host: `remote-host-connection.ts`.**
   `createRemoteHostConnection({hostKey, client, router, emit})` composes the
   backend, the bridge, and the router.

7. **A `RemoteHostClient` seam with multi-listener `subscribe`.** The connection
   consumes `{request, subscribe}`.

8. **Encrypted-at-rest registry: `remote-host-registry.ts`.** Paired hosts live
   in `<dataDir>/remote-hosts.json`.

9. **Boot hook: `bootstrap/remote-hosts.ts`.** `createRemoteHostsBoot(...)`
   reads the registry, opens one adapter + one connection per host, and returns
   `{open, closeAll}`.

## Invariants the kernel keeps

- **Renderer transport-agnosticism.** The renderer's `api.ts` code does not
  mention "remote".
- **Router-off default.** With no `RemoteBackend` registered, `route()` returns
  `ROUTE_LOCAL` for every call and the existing handler runs unchanged.
- **Least privilege at rest.** No plaintext device token ever touches disk.
- **Bounded shutdown.** `closeAll` closes every paired socket inside the same
  `Promise.allSettled` block that handles plugin, sidecar, and MCP disposals,
  before `host-core` is disposed, so in-flight remote turns can send their abort
  over a live socket.

## Out of scope

The kernel is complete for a paired host to answer renderer calls and stream
events. What is scheduled for later stages of R2:

- **Pairing UX (renderer + IPC).** Settings surfaces to enter a URL and pairing
  token, exchange it, and store the device token.
- **SSH bootstrap (Stage 4).** A supervisor that detects system `ssh`, downloads
  the `pi-host-bundle` (verified by SHA-256 from ADR 0285's release pipeline),
  starts the remote binary, and opens the `-L` tunnel.
- **Terminal work-panel client (Stage 5).** RACP terminal events are dropped by
  the event bridge; the work-panel session client will consume them.
- **Reverse tool relay (Stage 6).** A `RelayToolPort` bridge that lets the agent
  host run local desktop tools against a remote session.
- **Resync watchdog.** `resync.required` events are dropped today; the
  connection layer will eventually rebuild subscriptions from the last cursor
  per session (`RacpClient.cursorFor`).
- **Multi-listener contract.** `subscribe()` is used by exactly one consumer
  today (the event bridge); Stage 3b's resync watchdog will be the second.

## Alternatives considered

- **Route from each per-domain IPC handler.** Every one of 17 handlers would
  need to know about "remote" and duplicate the same dispatch.
- **Bake remote knowledge into the renderer.** A `remote:` prefix visible to the
  renderer forces `api.ts` to branch, and every store slice ends up aware of the
  transport.
- **Have the connection layer own its own RacpClient construction.** It would
  couple the coordinator to `packages/racp` and prevent unit tests from running
  without a real client.
- **A single-listener `RemoteHostClient`.** Simpler, but forces the resync
  watchdog and the event bridge to share the same callback.

## Consequences

- The desktop can host a paired remote `pi-host` today; adding a URL and device
  token to `<dataDir>/remote-hosts.json` (encrypted-at-rest through
  `safeStorage`) makes the kernel connect, register sessions, and stream events
  into the existing renderer, no other flag or setting required.
- `apps/desktop` now depends on `@pi-desktop/racp`, and the racp package
  publishes a `./test-harness` export subpath.
- `apps/desktop/electron/main/index.ts` stays at exactly 1500 LOC.
- Any Stage 4–7 work (SSH bootstrap, terminal work-panel client, reverse tool
  relay, pairing UX) plugs into existing seams — the router, the event bridge,
  the registry — and does not need to revisit the transport layer.
