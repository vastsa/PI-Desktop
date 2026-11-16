# ADR 0284: Headless runtime boundary in `packages/host-runtime`

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D447
- Related: ADR 0205 (D373 / D374 / D375), ADR 0213 (D386),
  `02-architecture/05-remote-agent-control.md` §4 and §11,
  `03-runtime/07-process-model.md` §4,
  `06-delivery/07-remote-control-rollout.md` R2

## Context

Rollout R1 delivered the headless Agent Host module (`packages/agent-host`), but
everything underneath it lived in `apps/desktop/electron/main` and was reached
through the desktop's own IPC handlers: the stdio transports to host-core and the
sidecar, the restart supervisor, the durable turn lifecycle, transcript persistence,
the in-flight reply checkpoint, and approved Plan/Goal execution (D189).

R2 needs the same runtime where no Electron exists: the `pi-host` bundle
(`02-architecture/05-remote-agent-control.md` §5.2) must run the Agent Host module,
the sidecar, and host-core behind a RACP server. Re-implementing the turn lifecycle
would create a second source of truth for the invariants the desktop spent a year
fixing — abort locks, stale terminal events, single-flight finalization, queue
release after durable settlement.

## Decision

1. **A new workspace package, `packages/host-runtime`, owns the
   Electron-independent runtime layer**, depending on `shared`, `agent-host`, and
   `agent-runtime` only, never on `electron` or `apps/desktop`:
   - `HostProcess` and `AgentSidecar` — the stdio NDJSON JSON-RPC transports, unchanged
     in behavior but taking their launch as options, with the sidecar's `host.proxy`
     allowlist, local-tool short circuit, Plan-mode gate, vendor-auth check, and
     trusted-extension bridge intact.
   - `RuntimeSupervisor` — the process-model §4 restart policy, single flight per
     child, never during shutdown, stopping on the first unrecoverable failure.
   - `RuntimeService` — `RuntimePort` for the module: prompt admission with the
     durable turn row and user message appended before the sidecar starts, steer,
     stop, the abort lock, asktool answers, manual compaction, and `finishTurn` with
     the desktop's claim-before-await rule, stale-terminal guard, and settlement
     announcement.
   - `TurnEventPipeline` and `TurnPersistence` — the per-event pass (tool-call
     tracking, D299 checkpoints, terminal events, completed rows) and an ordered
     append queue with bounded retry while host-core restarts; a `pi-host` process
     ends only with its supervisor, so no file-backed outbox is duplicated.
   - `createHeadlessLaunchResolver`, `PlanExecutionDispatcher` (D189), and host-core
     adapters for `SessionPort`, `QueueStore` (schema v15), `permissions.pending`, the
     session-message ledger, the inflight checkpointer, and the plan-execution
     decoders. The resolver refuses vendor OAuth accounts and plugin agents.
2. **Electron main keeps thin adapters**: `host-process.ts` and `agent-sidecar.ts`
   subclass the package classes to add packaged locations, `ELECTRON_RUN_AS_NODE`,
   redacted stderr, and schema-too-new / glibc diagnoses, while
   `runtime/lifecycle.ts` drives the shared supervisor and renderer status pushes. The
   local prompt path (`agent-ipc.ts`) stays desktop-owned.
3. **`TurnStartRequest` gains an optional `userMessageId`** so a client keeps its
   optimistic user row id through the headless runtime (D288). Additive.
4. **No wire contract changes**: Electron IPC, sidecar JSON-RPC, host-core RPC, and
   the Plugin SDK are untouched, and desktop behavior, defaults, and persisted data
   are unchanged.

## Consequences

- `pi-host` composes `HostProcess + AgentSidecar + RuntimeService + AgentHost +
  RuntimeSupervisor` in plain Node, and the restart policy, turn lifecycle, and
  transports become testable without Electron; the RACP server binds to the module
  rather than to Electron IPC.
- Local desktop sessions still run their own prompt path, and the headless resolver
  deliberately supports less — no attachments, plugin tools, MCP relay, or vendor
  OAuth — returning typed errors instead of degrading silently.

## Alternatives

- Extract only the transports and re-implement the lifecycle in `pi-host`: the
  invariants are the hard part and a copy would drift.
- Keep the modules in `apps/desktop/electron/main`: `packages/*` must not depend on
  desktop implementation code.
- Put the runtime into `packages/agent-host`: that module must stay free of process
  and filesystem knowledge.
