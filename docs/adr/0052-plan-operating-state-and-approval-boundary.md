# ADR 0052: Plan operating state and approval boundary

- Status: Superseded by ADR 0053
- Date: 2026-07-30
- Baseline: `0.4.13`
- Protocol: v7
- Storage schema: v8

ADR 0053 replaces this checkpoint with immutable unique host-written
`.pi/plan/*.md` artifacts, approve/reject-only resolution, the existing
`plan_approvals` artifact/execution fields, and a startup interruption fence
with no replay. The structured proposal/request-changes details below remain
historical context for the superseded design.

## Context

PI-Desktop's former product selector treated Chat and Agent as two tool
profiles. That vocabulary made a planning workflow ambiguous: a plan could be
described as another agent, a planner model, or a read-only permission mode.
Those interpretations would duplicate the pi runtime or put authorization in
the renderer.

The required workflow is one pi Agent that can inspect a task, submit a
structured plan, wait for a separate user decision, revise from feedback, and
continue execution only after approval. The workflow crosses the durable
session model, pi tool composition, Rust authorization, host RPC, renderer IPC,
plugin registration, storage recovery, and scheduled execution.

## Decision

### 1. One Agent, two operating states

The product selector is exactly `Agent | Plan`. There is one pi Agent per
session. Plan is that Agent after it enters planning state; it is not a second
Agent, planner service, planner model, or permission mode. Agent remains the
default for new sessions and new scheduled tasks.

The durable session mode is `agent | plan`. The live planning state is a
projection of the durable mode, runtime, and host approval record:

```text
Agent / inactive
  -> Plan / planning
  -> Plan / awaiting_approval
  -> Agent / inactive after approval, same Agent continues
```

The user may select Plan while idle. The same Agent may also call
`enter_plan_mode` while executing. Both paths converge on the same host-validated
Plan state. `ExitPlanMode` submits a structured plan and is the only assistant
tool call allowed in its batch.

The internal renderer `page = "chat"` value may remain as the conversation
surface route. It is not an operating mode and must not appear in mode
selectors, mode commands, or authorization decisions.

### 2. Host-owned durable authority

Rust host-core is authoritative for:

- resolving `sessions.mode` from the durable `sessionId` on every tool call;
- enforcing the Plan/Agent tool policy before permission modes and grants;
- creating and resolving durable plan approval records;
- committing the Plan → Agent transition with the selected permission mode;
- emitting normalized approval/state events and applying timeout/recovery;
- scheduled/unattended policy and stable error codes.

Renderer state and sidecar mode fields are projections or diagnostic context.
A conflicting mode supplied by Electron or the sidecar cannot authorize a
tool. A stale renderer cannot clear Plan or grant execution.

### 3. Plan tool and permission policy

Plan exposes:

- `read`, `glob`, `grep`, and `browser_preview`;
- `bash`, governed by the durable permission mode;
- `ExitPlanMode` (this list also carried `CompactContext`, removed by
  ADR 0061 and restored by ADR 0064 as `new_context`).

Plan denies `write`, `edit`, every plugin tool, and unknown tools, regardless of
permission mode, session grant, manifest risk, or stale IPC state. Agent keeps
the existing `read`, `glob`, `grep`, `write`, `edit`, `bash`, and registered
plugin policy.

Plan retains permission-mode selection. bash prompts under `ask` and
`accept-edits`; bash under `auto` runs without confirmation and may mutate the
workspace or scratch directory. browser_preview is the explicit read-only UI
inspection exception. Plan therefore expresses planning intent, not a strict
read-only security profile. The UI must state this tradeoff.

### 4. Separate plan approval transaction

`ExitPlanMode` creates a host-owned `plan_approvals` row with request, session,
turn, tool-call, structured plan, deadline, and pending status. The host emits
the request and waits on an in-memory one-shot channel; the row preserves the
proposal and final outcome but does not make a dead Agent resumable.

Approval is not a generic tool permission. `plans.resolve` accepts only a
matching live request/session/turn. Approval requires an explicit target
permission mode, defaults to `ask` in the UI, and commits atomically:

```text
BEGIN
  plan_approvals: pending -> approved
  sessions.mode: plan -> agent
  sessions.permission_mode: selected explicit mode
  append audit record
COMMIT
wake ExitPlanMode
start a new model turn with Agent tools
```

Requesting changes requires non-empty feedback, records the outcome, returns
the feedback to the same Agent as a Plan tool result, and leaves the session in
Plan. Reject records the outcome, stops the run, and leaves Plan active.

Timeout, abort, persistence failure, host crash, sidecar crash, and stale
responses fail closed. Full process restart marks pending approvals
`interrupted`, aborts associated turns, keeps sessions in Plan, and rejects
old responses. Renderer reload may restore only a request backed by a live
host waiter.

### 5. Migration and protocol

Schema v8 is a transactional v7 migration. It maps persisted session mode,
app default mode, and scheduled task mode values from `chat` to `plan`, keeps
transcripts/turns/permissions, adds `plan_approvals`, and leaves schema v7
authoritative on failure. New defaults remain Agent. Protocol v7 carries the
`plan | agent` union, plan state events, structured approval events, and
`plans.pending` / `plans.resolve` RPCs.

### 6. Scheduled and plugin policy

Plan is interactive-only in this release. A scheduled or unattended Plan run
fails before the provider request with `PLAN_REQUIRES_INTERACTIVE_SESSION`; no
background process displays or auto-approves a plan. Existing scheduled Chat
values migrate to Plan and require an explicit switch to Agent before running
unattended.

Plugin agent tools are Agent-only contributions. Plan hides and denies them at
the host boundary even when their manifest risk is low or permission is
granted. Plugin commands and panels remain explicit user UI contributions, but
cannot become model-callable Plan tools.

## Consequences

### Positive

- Planning preserves one Agent context and avoids a second planner lifecycle.
- Durable host authorization cannot be bypassed by renderer or sidecar state.
- Users can choose the post-approval permission posture explicitly.
- Feedback, recovery, migration, plugin denial, and scheduled behavior are
  observable and testable through stable protocol/storage contracts.

### Tradeoffs

- Plan is not a strict mutation-free mode because Auto bash can mutate. This is
  intentional and must be visible in the product copy and approval UX.
- A full process crash discards an in-flight Agent wait; the proposal is kept
  as an interrupted record, but the user must submit a new plan.
- Protocol and schema version bumps require synchronized host, sidecar, main,
  renderer, migration, and compatibility work.

## Alternatives rejected

### A second planner Agent or model

Rejected because it duplicates context, introduces a second approval/runtime
boundary, and conflicts with the requirement that feedback and approval return
to the same Agent.

### Plan as a permission mode or strict read-only profile

Rejected because planning intent and authorization posture are distinct. Plan
must retain permission selection and bash behavior, including Auto's explicit
mutation tradeoff.

### Renderer-owned mode or approval state

Rejected because stale or forged IPC could grant execution and renderer reload
would lose the authoritative transition. Rust owns durable mode, policy, and
approval identity.

### Command-text classification to permit `bash` in Plan

Rejected because a general shell command cannot be proven read-only reliably.
The existing permission mode is the explicit control; Plan's write/edit/plugin
denials remain exact tool policy.

## Related docs

- `docs/spec/00-baseline.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/05-host-core-rust.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/07-process-model.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/03-runtime/10-session-state-machine.md`
- `docs/spec/04-ux/03-permission-ux.md`
- `docs/spec/04-ux/04-builtin-commands.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/05-security/01-security.md`
- `docs/spec/07-plugins/04-plugin-security.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D188)
