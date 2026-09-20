# ADR 0284: Headless runtime boundary in `packages/host-runtime`

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D447
- Related: ADR 0205 (D373 / D374 / D375), ADR 0213 (D386),
  `02-architecture/05-remote-agent-control.md` §4 and §11,
  `03-runtime/07-process-model.md` §4,
  `06-delivery/07-remote-control-rollout.md` R2

## Context

Rollout R1 delivered the headless Agent Host module (`packages/agent-host`):
admission, the turn queue, the approval broker, the event log, and the
snapshot builder run without Electron. Everything underneath it did not. The
stdio transports to host-core and the agent sidecar, the restart supervisor,
the durable turn lifecycle (`session.beginTurn` → prompt → `session.endTurn`),
transcript persistence, the in-flight reply checkpoint, and approved
Plan/Goal execution all lived in `apps/desktop/electron/main`, and the
Electron `AgentHost` bridge reached them by invoking the desktop's own IPC
handlers. `HostProcess` resolved the binary from `process.resourcesPath`, and
`AgentSidecar` could only start the sidecar as
`process.execPath` + `ELECTRON_RUN_AS_NODE`.

R2 needs the same runtime on a machine that has no Electron: the `pi-host`
bundle (`02-architecture/05-remote-agent-control.md` §5.2) must run the Agent
Host module, the sidecar, and host-core behind a RACP server. Re-implementing
the turn lifecycle in a second place would create a second source of truth
for exactly the invariants the desktop spent a year fixing (abort locks,
stale terminal events, single-flight finalization, queue release after
durable settlement).

## Decision

1. **A new workspace package, `packages/host-runtime`, owns the
   Electron-independent runtime layer.** It depends on `shared`,
   `agent-host`, and `agent-runtime` only, and never on `electron` or on
   `apps/desktop`. Its modules are:
   - `HostProcess` and `AgentSidecar`: the stdio NDJSON JSON-RPC transports,
     moved from Electron main unchanged in behavior. Both take their launch
     as options — `binaryPath` / `dataDir` / extra `env` for host-core,
     `{ command, args, env }` for the sidecar — and an `onStderr` sink. The
     sidecar's `host.proxy` allowlist, local-tool short circuit, Plan-mode
     gate, vendor-auth binding check, and trusted-extension bridge are
     unchanged. `HostProcess` accepts an optional `diagnoseFailure` hook so
     an embedding host can name a boot refusal it can phrase.
   - `RuntimeSupervisor`: the restart policy of process-model §4 (0.5s → 1s
     → 2s capped at 4s, three restarts per two-minute window, single flight
     per child, never during shutdown, stop on the first unrecoverable
     failure). The embedding host supplies `start`, `afterRestart`,
     `isUnrecoverable`, and an event sink.
   - `RuntimeService`: `RuntimePort` for the Agent Host module on top of the
     two transports — prompt admission with the durable turn row and the
     user message appended before the sidecar starts, steer, stop, abort
     with the abort lock, asktool answers, manual compaction, and
     `finishTurn` with the same claim-before-await rule, stale-terminal
     guard, and settlement announcement as Electron main.
   - `TurnEventPipeline` and `TurnPersistence`: the per-event pass
     (tool-call tracking, D299 checkpoints, terminal events, completed rows)
     and an in-memory ordered append queue with a bounded retry while
     host-core restarts. A `pi-host` process ends only with its supervisor,
     so the desktop's file-backed outbox is not duplicated.
   - `createHeadlessLaunchResolver`: launch resolution from host-core's own
     registries (providers and secrets, the effective command shell, project
     instructions and memory, user skills, subagent definitions). It refuses
     vendor OAuth accounts and plugin agents, which need the desktop.
   - `PlanExecutionDispatcher`: approved Plan/Goal execution (D189) with the
     same claim, no-replay, and finalization rules.
   - Host-core adapters for the module's `SessionPort`, `QueueStore`
     (schema v15), and `permissions.pending`, plus the session-message
     ledger lookup, the inflight checkpointer, and the plan-execution
     decoders, moved out of Electron main.
2. **Electron main keeps thin adapters.** `electron/main/host-process.ts`
   and `agent-sidecar.ts` subclass the package classes and add only what
   Electron knows: the packaged binary and bundled-plugin locations, the
   `ELECTRON_RUN_AS_NODE` launch, redacted stderr logging, and the
   schema-too-new / glibc diagnoses. `runtime/lifecycle.ts` drives the shared
   supervisor and keeps the renderer status pushes, plugin locale resync,
   and approved-plan drain. The Agent Host bridge uses the shared host-core
   ports instead of its own copies. The local prompt path (`agent-ipc.ts`),
   with its attachments, slash expansion, plugin tools, MCP relay, vendor
   accounts, and notifications, is unchanged and still owned by the desktop.
3. **`TurnStartRequest` gains an optional `userMessageId`** so a client can
   keep its optimistic user row id through the headless runtime, exactly as
   the renderer does through IPC (D288). Additive; no caller is required to
   send it.
4. **No wire contract changes.** Electron IPC, the sidecar JSON-RPC, host-core
   RPC, and the Plugin SDK are untouched; the desktop's observable behavior,
   defaults, and persisted data are unchanged.

## Consequences

- `pi-host` (R2) can compose `HostProcess + AgentSidecar + RuntimeService +
  AgentHost + RuntimeSupervisor` in plain Node; the RACP server binds to the
  module, never to Electron IPC.
- The restart policy, the turn lifecycle, and the transports now have unit
  tests that run without Electron (`packages/host-runtime/src/*.test.ts`).
- The desktop's source-contract tests that pinned `host-process.ts` and
  `agent-sidecar.ts` now read the package sources; the renderer-facing
  status and diagnosis assertions still read the Electron adapters.
- Local Electron main still runs its own prompt path through IPC. Moving the
  desktop onto `RuntimeService` for local sessions is a later,
  behavior-preserving step; it is not required for R2 and is not done here.
- The headless resolver deliberately supports less than the desktop:
  no prompt attachments, no plugin tools, no desktop MCP relay, no vendor
  OAuth. Those return typed errors rather than degrading silently.

## Alternatives considered

- **Extract only the transports and re-implement the turn lifecycle in
  `pi-host`.** Rejected: the lifecycle invariants are the hard part, and a
  second copy would drift from the desktop's.
- **Keep the modules in `apps/desktop/electron/main` and import them from
  `pi-host`.** Rejected: `packages/*` must not depend on desktop
  implementation code, and the modules would keep growing Electron imports.
- **Put the runtime into `packages/agent-host`.** Rejected: the module is the
  transport-free semantic core with no process or filesystem knowledge, and
  the RACP server and integrations depend on it staying that way.
