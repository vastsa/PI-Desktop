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
authentication. What was still missing on the desktop side of R2 was the
kernel — the code that lets the renderer treat a remote session exactly the
way it treats a local one (spec §3.4). Without it, the transport can only be
observed from tests.

Three constraints shaped the kernel:

- The renderer must never learn the transport. Every existing per-session IPC
  call — 17 channels covering agent, session, tool approval, ask-tool, and
  plan resolution — has one call site in `apps/desktop/src/lib/api.ts` that
  cannot know whether the answer came from `host-core` or from a paired host.
- The frozen architecture pins `apps/desktop/electron/main/index.ts` at
  1500 LOC (`scripts/check-architecture.mjs`). Every new module must live
  outside it; wiring must fit the existing composition root.
- The desktop cannot open a network listener of its own (security §7). All
  outbound flows go through the RACP client to a host the user paired with,
  and every registration is per-session so a lost host cannot silently
  hijack a local session id.

## Decision

The desktop-side R2 kernel is five modules and one boot hook, all under
`apps/desktop/electron/main/remote/` (module state) and
`apps/desktop/electron/main/bootstrap/` (boot state), and one new workspace
dependency (`@pi-desktop/racp`).

1. **A single interception seam: `backend-router.ts`.** The router is
   consulted from `ipc/register.ts`'s `handle()` wrapper; it returns the
   sentinel `ROUTE_LOCAL` when no `RemoteBackend` is registered for the call's
   session id, and the local handler runs unchanged. A session becomes remote
   only once its renderer-visible id (`remote:<hostKey>:<hostSessionId>`,
   mirroring `native-pi:`) has an explicit registration. This makes remote
   support byte-for-byte compatible when disabled and prevents accidental
   routing of a local id.

   > **Amended by ADR 0308 (D628).** The `ROUTE_LOCAL` fallthrough is correct
   > for an *unknown* id, but a `remote:`-namespaced id whose backend is absent
   > or offline must not fall through to the local handler. The router now fails
   > closed on a `remote:` id with no live backend and keeps routing local for
   > an unregistered local id. The router-off default for builds with no paired
   > host is unchanged.

2. **A stateless per-request session id.** `sessionIdForCall` recovers the
   session from either the first positional argument, `first.sessionId`,
   `first.id` (`sessionGet` uses this shape), or a
   `<remoteSessionId>#racp-approval:<hostApprovalId>` requestId used by tool
   approval. This last one lets `toolResolvePermission` route without a
   correlation map: the router encodes the session into the id it hands the
   renderer and decodes it when the renderer echoes the id back.

3. **A transport-agnostic backend: `remote-backend.ts`.** One
   `createRemoteBackend({hostKey, client, ...})` instance serves every session
   of a paired host — the router registers it under each id. The backend
   translates 17 channels to RACP requests and reshapes the results back into
   the exact response shapes `apps/desktop/src/lib/api.ts` already returns for
   the local handler. Channels the remote profile does not cover
   (`agentSteer`, attachments, desktop-only settings) either return false from
   `handles()` or throw `CAPABILITY_UNAVAILABLE`, so those calls fall back to
   the local handler while the session's transcript stays remote.

4. **Two synthesis rules to reconcile schema mismatches without a
   round-trip.**
   - Tool-approval resolution has no session id in its wire payload, so the
     backend encodes `<remoteSessionId>#racp-approval:<hostApprovalId>` into
     the requestId (§ Decision 2) and decodes it back for `approval/respond`.
   - `plansResolve` returns `PlanResolutionResult` to the renderer, but RACP's
     `approval/respond` returns only `RacpApprovalResult`. The backend
     synthesizes a minimal `PlanProposal` from the request identity to dismiss
     the card optimistically; the authoritative snapshot arrives on the
     follow-up `session.changed` event and replaces the placeholder.

5. **A pure event bridge: `remote-event-bridge.ts`.** RACP events are
   translated into `IPC.event.agentMessage` / `IPC.event.sessionsChanged` for
   the renderer. Item/turn/tool payloads already carry a local `AgentEvent`
   in `payload.event` and forward verbatim under an `AgentEventEnvelope` keyed
   by the remote session id. `approval.requested` of kind `tool` becomes a
   local `tool_permission_request` with the encoded requestId; plan and goal
   approvals ride the following `planning_state` event and are dropped. An
   `onLifecycle` callback signals `session.created`/`archived` for the router
   without a second subscription to the same stream.

6. **A coordinator per paired host:
   `remote-host-connection.ts`.** `createRemoteHostConnection({hostKey,
   client, router, emit})` composes the backend, the bridge, and the router.
   Its `open()` sequence closes the create-race between listing sessions and
   receiving lifecycle events: attach listener → subscribe host scope →
   `session/list` → per-session subscribes. `close()` unregisters every
   session and drops internal state; it is idempotent and safe to call before
   `open()`.

7. **A `RemoteHostClient` seam with multi-listener `subscribe`.** The
   connection consumes `{request, subscribe}`. `packages/racp` exposes
   `RacpClient.onEvent` as a single-slot construction option, which is not
   enough for a bridge + resync watchdog + later features. `racp-remote-host-client.ts`
   is the only file in `electron/main/remote/` that imports
   `@pi-desktop/racp`; it wraps the client, fans out its callback to every
   `subscribe()` listener, and swallows listener throws so a bad subscriber
   cannot silence the others.

8. **Encrypted-at-rest registry: `remote-host-registry.ts`.** Paired hosts
   live in `<dataDir>/remote-hosts.json`. Device tokens are encrypted with
   Electron's `safeStorage` before write and decrypted on read; a stolen file
   without keychain access reveals only URL and label. The registry is
   injected with an `EncryptionPort` (isAvailable / encryptString /
   decryptString) so Node-side tests supply a fake without pulling in
   Electron. `upsert` refuses to write when the keychain is unavailable;
   `list` drops any record it cannot decrypt rather than surfacing an empty
   token that would auth-fail downstream.

9. **Boot hook: `bootstrap/remote-hosts.ts`.** `createRemoteHostsBoot(...)`
   reads the registry, opens one adapter + one connection per host, and
   returns `{open, closeAll}`. Sequential open — a host's failure is logged
   and skipped, not fatal. An empty registry (the default install) is a full
   no-op: nothing connects, no backend registers, every renderer call keeps
   hitting the local handler byte-for-byte. `bootstrap/startup.ts` calls
   `open()` in the background so a slow host never delays the first window;
   `bootstrap/shutdown.ts` calls `closeAll()` from the existing shutdown
   promise so paired sockets are drained before host-core is torn down. A
   single module-level `activeRemoteHostsBoot` handle bridges startup and
   shutdown without expanding `index.ts` past its 1500-LOC ceiling.

## Invariants the kernel keeps

- **Renderer transport-agnosticism.** The renderer's `api.ts` code does not
  mention "remote". Its session ids may be namespaced; every response shape it
  parses is the local one.
- **Router-off default.** With no `RemoteBackend` registered, `route()`
  returns `ROUTE_LOCAL` for every call and the existing handler runs
  unchanged. Adding the kernel to a build without pairing is a zero-behavior
  change.
- **Least privilege at rest.** No plaintext device token ever touches disk.
  A `safeStorage` unavailable environment cannot write a token; it can still
  read what was already written when that platform was available.
- **Bounded shutdown.** `closeAll` closes every paired socket inside the same
  `Promise.allSettled` block that handles plugin, sidecar, and MCP disposals,
  before `host-core` is disposed, so in-flight remote turns can send their
  abort over a live socket.

## Out of scope

The kernel is complete for a paired host to answer renderer calls and stream
events. What is scheduled for later stages of R2:

- **Pairing UX (renderer + IPC).** Settings surfaces to enter a URL and
  pairing token, exchange it, and store the device token. The registry API
  is ready for this; the surface is not.
- **SSH bootstrap (Stage 4).** A supervisor that detects system `ssh`,
  downloads the `pi-host-bundle` (verified by SHA-256 from ADR 0285's
  release pipeline), starts the remote binary, and opens the `-L` tunnel.
  Every paired host today assumes the loopback URL already exists.
- **Terminal work-panel client (Stage 5).** RACP terminal events are dropped
  by the event bridge; the work-panel session client will consume them.
- **Reverse tool relay (Stage 6).** A `RelayToolPort` bridge that lets the
  agent host run local desktop tools against a remote session. Belongs on the
  agent-host and pi-host, not on `packages/racp`.
- **Resync watchdog.** `resync.required` events are dropped today; the
  connection layer will eventually rebuild subscriptions from the last
  cursor per session (`RacpClient.cursorFor`).
- **Multi-listener contract.** `subscribe()` is used by exactly one consumer
  today (the event bridge); Stage 3b's resync watchdog will be the second.

## Alternatives considered

- **Route from each per-domain IPC handler.** Every one of 17 handlers would
  need to know about "remote" and duplicate the same dispatch. Rejected:
  God-modules would grow, and any new channel would need to be wired in twice.
- **Bake remote knowledge into the renderer.** A `remote:` prefix visible to
  the renderer forces `api.ts` to branch, and every store slice ends up
  aware of the transport. Rejected by spec §3.4.
- **Have the connection layer own its own RacpClient construction.** It would
  couple the coordinator to `packages/racp` and prevent unit tests from
  running without a real client. Rejected in favour of the injected
  `RemoteHostClient` seam.
- **A single-listener `RemoteHostClient`.** Simpler, but forces the resync
  watchdog and the event bridge to share the same callback. Rejected: their
  concerns are independent and their subscriptions should be too.
- **Plain-text registry.** Simpler read/write, but a compromised backup would
  hand attackers a device token that authenticates against a real `pi-host`.
  Rejected by security §3.4.

## Testing

Every module has a `node --test` fixture that exercises the seam in isolation
(fake RACP client, fake encryption, fake router). The RACP adapter runs
against the real in-memory harness (`@pi-desktop/racp/test-harness`), so its
fan-out and lifecycle contracts are checked against the same client the
production factory builds. The full desktop suite runs 2120+ tests with the
kernel on and every one passes; no `test:e2e:*` scenario is scheduled for the
kernel alone because it is dead code until pairing lands.

## Consequences

- The desktop can host a paired remote `pi-host` today; adding a URL and
  device token to `<dataDir>/remote-hosts.json` (encrypted-at-rest through
  `safeStorage`) makes the kernel connect, register sessions, and stream
  events into the existing renderer, no other flag or setting required.
- `apps/desktop` now depends on `@pi-desktop/racp`, and the racp package
  publishes a `./test-harness` export subpath. Both changes are additive.
- `apps/desktop/electron/main/index.ts` stays at exactly 1500 LOC. The
  startup/shutdown bridge is a module-level handle inside
  `bootstrap/remote-hosts.ts` — small, contained, and easy to remove once
  R2b lets the wiring live inside a broader remote-hosts service object.
- Any Stage 4–7 work (SSH bootstrap, terminal work-panel client, reverse
  tool relay, pairing UX) plugs into existing seams — the router, the event
  bridge, the registry — and does not need to revisit the transport layer.
