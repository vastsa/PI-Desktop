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
admission, the turn queue, the approval broker, the event log, and the snapshot
builder run without Electron. Everything underneath it did not.

## Decision

1. **A new workspace package, `packages/host-runtime`, owns the
   Electron-independent runtime layer.** It depends on `shared`, `agent-host`,
   and `agent-runtime` only, and never on `electron` or on `apps/desktop`.
   - `HostProcess` and `AgentSidecar`: the stdio NDJSON JSON-RPC transports,
     moved from Electron main unchanged in behavior.
   - `RuntimeSupervisor`: the restart policy of process-model §4 (0.5s → 1s → 2s
     capped at 4s, three restarts per two-minute window, single flight per
     child, never during shutdown, stop on the first unrecoverable failure).
   - `RuntimeService`: `RuntimePort` for the Agent Host module on top of the two
     transports — prompt admission with the durable turn row and the user
     message appended before the sidecar starts, steer, stop, abort with the
     abort lock, asktool answers, manual compaction, and `finishTurn` with the
     same claim-before-await rule, stale-terminal guard, and settlement
     announcement as Electron main.
   - `TurnEventPipeline` and `TurnPersistence`: the per-event pass (tool-call
     tracking, D299 checkpoints, terminal events, completed rows) and an
     in-memory ordered append queue with a bounded retry while host-core
     restarts.
   - `createHeadlessLaunchResolver`: launch resolution from host-core's own
     registries (providers and secrets, the effective command shell, project
     instructions and memory, user skills, subagent definitions).
   - `PlanExecutionDispatcher`: approved Plan/Goal execution (D189) with the
     same claim, no-replay, and finalization rules.
   - Host-core adapters for the module's `SessionPort`, `QueueStore` (schema
     v15), and `permissions.pending`, plus the session-message ledger lookup,
     the inflight checkpointer, and the plan-execution decoders, moved out of
     Electron main.
2. **Electron main keeps thin adapters.** `electron/main/host-process.ts` and
   `agent-sidecar.ts` subclass the package classes and add only what Electron
   knows: the packaged binary and bundled-plugin locations, the
   `ELECTRON_RUN_AS_NODE` launch, redacted stderr logging, and the
   schema-too-new / glibc diagnoses.
3. **`TurnStartRequest` gains an optional `userMessageId`** so a client can keep
   its optimistic user row id through the headless runtime, exactly as the
   renderer does through IPC (D288).
4. **No wire contract changes.** Electron IPC, the sidecar JSON-RPC, host-core
   RPC, and the Plugin SDK are untouched; the desktop's observable behavior,
   defaults, and persisted data are unchanged.

## Consequences

- `pi-host` (R2) can compose `HostProcess + AgentSidecar + RuntimeService +
  AgentHost + RuntimeSupervisor` in plain Node; the RACP server binds to the
  module, never to Electron IPC.
- The restart policy, the turn lifecycle, and the transports now have unit tests
  that run without Electron (`packages/host-runtime/src/*.test.ts`).
- The desktop's source-contract tests that pinned `host-process.ts` and
  `agent-sidecar.ts` now read the package sources; the renderer-facing status
  and diagnosis assertions still read the Electron adapters.
- Local Electron main still runs its own prompt path through IPC.
- The headless resolver deliberately supports less than the desktop: no prompt
  attachments, no plugin tools, no desktop MCP relay, no vendor OAuth.

## Alternatives considered

- **Extract only the transports and re-implement the turn lifecycle in
  `pi-host`.** Rejected: the lifecycle invariants are the hard part, and a
  second copy would drift from the desktop's.
- **Keep the modules in `apps/desktop/electron/main` and import them from
  `pi-host`.** Rejected: `packages/*` must not depend on desktop implementation
  code, and the modules would keep growing Electron imports.
- **Put the runtime into `packages/agent-host`.** Rejected: the module is the
  transport-free semantic core with no process or filesystem knowledge, and the
  RACP server and integrations depend on it staying that way.
