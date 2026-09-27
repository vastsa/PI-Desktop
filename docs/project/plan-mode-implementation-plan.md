# Plan Checkpoint and Shell Implementation Plan

- Status: Implemented and accepted on 2026-08-05
- Scope: Plan checkpoint approval/execution and selectable command shells
- Core runtime: one `@earendil-works/pi-agent-core` Agent per session
- Baseline: `0.4.14`
- Host protocol: v9
- Database schema: v10
- Delivery: M6 complete; Host/no-replay, pending-restore, and terminal-card
  non-hydration evidence accepted

## 1. Executive decision

PI-Desktop continues to run one pi Agent. The selector is `Agent | Plan`, with
Agent as the default. Plan is the same Agent in planning state, not a second
planner, model, service, permission mode, or security sandbox.

Plan exposes Read, Glob, Grep, BrowserPreview, Bash, CompactContext,
EnterPlanMode, and SubmitPlan. Write, Edit, plugin tools, and unknown tools are
denied by Rust host-core. Bash follows the selected permission mode, so Plan is
planning intent rather than strict read-only security.

`SubmitPlan(title, markdown, question)` is the only tool in its assistant batch.
Host-core writes the submitted Markdown bytes unchanged to one new immutable
file under `<workspaceRoot>/.pi/plan/*.md`. It records the unique relative
path, SHA-256, and byte size, plus the structured title and question, in the
same approval row. It does not add a title/question wrapper or replace an
earlier artifact. The approval surface offers only Approve and Reject, defaults
the explicit permission choice to Ask, and opens the artifact for review.

Approval atomically changes the durable session to Agent, stores the selected
permission mode, and queues the same Agent's next execution turn. The approval
uses one absolute 30-minute deadline and reports expiry as
`PLAN_APPROVAL_TIMEOUT`. Pending, queued, and running work is interrupted on
host restart with no replay. A pending interruption leaves the session Plan;
an already-approved queued or running interruption leaves it Agent.

The Bash tool retains its protocol name while using a host shell catalog. The
catalog IDs are `windows-powershell`, `cmd`, `git-bash`, and `bash`. The
effective shell ID and dialect are pinned for each turn, stdout/stderr stream
separately, the default timeout is exactly 60 seconds, explicit timeouts are
bounded to 1-300 seconds, and cancellation shuts down the full process tree.

## 2. Invariants and vocabulary

| Concept | Values | Authority |
|---|---|---|
| Durable operating mode | `agent`, `plan` | Rust host SQLite |
| Live Plan state | `planning`, `awaiting_approval`, `inactive`, `stopped` | Host/runtime projection |
| Approval action | `approve`, `reject` | Host RPC |
| Approval status | `pending`, `approved`, `rejected`, `expired`, `interrupted` | `plan_approvals.status` |
| Execution state | `queued`, `running`, `completed`, `interrupted` | `plan_approvals.execution_state` |
| Permission mode | `inherit`, `ask`, `accept-edits`, `auto` | Host settings/session policy |
| Shell ID | `windows-powershell`, `cmd`, `git-bash`, `bash` | Host catalog/settings |
| Shell dialect | `powershell`, `cmd`, `posix` | Effective shell option |

The renderer and sidecar hold projections. The renderer retains the latest Plan
proposal/execution snapshot per session only for its current lifetime from live
Host events. `plans.pending` rehydrates only pending approvals; terminal rows
remain Host-owned durable records but do not rehydrate terminal cards. Neither
renderer nor sidecar can authorize a mode, write or replace a plan artifact,
choose an executable path, or revive an interrupted approval or execution.

## 3. State lifecycle

```text
Agent / inactive
  -> user selects Plan or Agent calls EnterPlanMode
Plan / planning
  -> SubmitPlan(title, markdown, question)
Plan / awaiting_approval
  -> approve(permission mode) -> Agent / queued -> Agent / running
  -> reject | expiry | abort | persistence failure -> Plan / stopped
host restart
  -> plan_approvals.pending -> interrupted
  -> plan_approvals.execution_state queued/running -> interrupted
```

Rules:

1. One pi Agent exists for the session before, during, and after planning.
2. `EnterPlanMode` and `SubmitPlan` are each the only tool call in their
   assistant batch.
3. Approval resolution matches proposal, session, turn, tool-call, and version
   identity. There is no serialized process-epoch field.
4. A pending approval has one absolute 30-minute deadline; renderer reload
   never resets it and restores only that still-pending row through
   `plans.pending`. Terminal proposal/execution snapshots are not rehydrated.
5. Reject and expiry leave a pending session in Plan and grant no execution.
6. Approval commits Agent mode before a queued/running execution begins.
7. Startup fences prior live work transactionally before serving RPC. No
   provider, tool, or queue work is replayed.

## 4. Turn and configuration boundaries

Each session has one active turn, at most one pending approval, and at most one
queued or running execution. A second prompt, Plan submission, execution, or
mode/provider/model/permission/shell configuration change is rejected while
that boundary is active. Configuration is accepted only while idle. Approval
actions are the only enabled controls for a pending request. Different
sessions retain existing independent turn and workspace-root behavior.

Scheduled or unattended Plan is rejected before provider work, artifact write,
approval, or queue insertion with `PLAN_REQUIRES_INTERACTIVE_SESSION`.

## 5. SubmitPlan and artifact contract

```ts
type SubmitPlanInput = {
  title: string;
  markdown: string;
  question: string;
};
```

Host-core validates the project-bound session and writes the exact bytes of
`markdown` to a new unique file matching:

```text
<workspaceRoot>/.pi/plan/<unique-name>.md
```

The write is host-owned and create-new. The artifact directory is created
defensively, the bytes are flushed, and the relative path is stored in
`plan_approvals.artifact_relative_path`. `title` and `question` are stored in
their own structured columns. No canonical UTF-8/LF conversion, final newline,
title heading, question heading, or other wrapper is added. A path validation,
symlink, write, or collision failure creates no approval row and returns the
corresponding `PLAN_ARTIFACT_*` error.

Approval receives the artifact opener path and durable hash/size metadata. The
UI is required to display the title, question, artifact opener, expiry, and
status; it is not required to inline Markdown, SHA-256, or byte size.

## 6. Approval and execution contract

```ts
type PlanResolveRequest = {
  proposalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
  action: "approve" | "reject";
  targetPermissionMode?: "ask" | "accept-edits" | "auto";
};
```

Approval is an atomic `plan_approvals` transaction:

```text
BEGIN
  plan_approvals.status: pending -> approved
  plan_approvals.execution_id: new ID
  plan_approvals.execution_state: NULL -> queued
  sessions.mode: plan -> agent
  sessions.permission_mode: explicit selected mode
COMMIT
dispatch the same Agent's fresh execution turn
```

Reject records `rejected` without a permission mode and leaves the session in
Plan. Expiry records `expired` with `PLAN_APPROVAL_TIMEOUT`. Abort and startup
recovery record `interrupted`. The execution worker claims `queued`, runs it,
and finishes it as `completed` or `interrupted`. No process epoch is serialized
in the row or request; startup state marking is the replay fence.

## 7. Storage contract

Schema v10 continues the host-owned `plan_approvals` table. Its checkpoint and
execution fields include:

```text
request_id, session_id, turn_id, tool_call_id
plan_json                 exact submitted Markdown snapshot
title, question           structured DB fields
status, action, target_permission_mode, feedback
created_at, updated_at, expires_at, resolved_at, error_code, version
artifact_relative_path, artifact_sha256, artifact_size_bytes
execution_id, execution_state
```

There are no separate `plan_artifacts` or `plan_runs` tables and no serialized
`hostEpoch` field. The artifact itself is the immutable Markdown file under
`.pi/plan/`; the approval row indexes it and carries the execution descriptor.

At database open, one startup transaction marks every prior `pending` approval
and every prior `queued` or `running` execution state as `interrupted`, aborts
associated running turns, and commits audit records before the host serves RPC.
Renderer reload within the same host can recover a pending row and its original
deadline. Rejected, expired, approved/completed, and interrupted terminal cards
are not rehydrated after reload. A host restart cannot recover actionable work,
restores no stale action, and never replays it; the UI is not required to show
the interrupted terminal snapshot.

The v8-to-v10 path checkpoints WAL, creates an exact readable
`pi.sqlite.v8.bak` before destructive work, and applies one atomic transaction;
the v9 path creates `pi.sqlite.v9.bak`, while v7 first reaches v8 and then uses
the same guarded path. The migration preserves sessions, transcripts, turns,
permissions, and legacy approval data while adding/backfilling the artifact and
execution fields and indexes on `plan_approvals`. It maps persisted `chat`
values to `plan`, validates the shell setting, and writes `PRAGMA user_version =
10` last. Malformed app settings or scheduled config, invalid modes, and an
invalid default shell fail closed with schema v8 authoritative. It does not
reconstruct artifacts or queue work from transcript text.

## 8. Selectable shell contract

Host-core returns a platform-aware catalog:

| Platform | IDs in catalog |
|---|---|
| Windows | `windows-powershell`, `cmd`, `git-bash` |
| macOS/Linux | `bash` |

Each option contains its stable ID, display label, dialect, availability, and
default marker. Settings writes reject unknown, unavailable, and
wrong-platform IDs with `COMMAND_SHELL_INVALID`. If a persisted configured ID
later becomes unavailable, the effective selection intentionally falls back to
the first available shell for that platform and marks `fallback: true`. If no
shell is available, Bash returns `SHELL_NOT_FOUND`.

The runtime pins the effective ID and dialect at turn launch. The Bash request
includes the expected ID; host-core resolves the current catalog immediately
before spawn and rejects a stale ID/dialect with `COMMAND_SHELL_CHANGED`. This
is a catalog identity check, not executable path hashing. A fallback may select
the effective shell before the turn is pinned, but execution never changes
shell after the pin.

`Bash` and `tools.execute` remain the protocol/tool names. Host streams
stdout/stderr independently and returns a bounded final result. Missing
`timeoutMs` means exactly 60,000 ms; an explicit value is accepted only in
1,000..300,000 ms. Timeout and user abort terminate the complete Unix process
group or Windows process/job tree before streams close.

## 9. Delivery slices

1. **Contract freeze**: ADR 0053/0054, D189/D190, baseline 0.4.14, protocol v9,
   schema v10, and E2E-104-E2E-117.
2. **Storage/host boundary**: immutable artifact writer, `plan_approvals`
   fields/indexes, startup interruption transaction, queue transitions,
   scheduled rejection, and error mapping.
3. **Agent/RPC vertical slice**: SubmitPlan, same-Agent approval, reject/expiry,
   idle/configuration guards, and no-replay restart recovery.
4. **Shell execution slice**: catalog/default persistence, platform validation,
   effective fallback, turn pinning, stale-ID rejection, streamed output,
   timeout bounds, and process-tree cancellation.
5. **Desktop interaction**: artifact opener approval card, status/expiry
   presentation, shell Settings, renderer reload behavior, localization, and
   diagnostics.
6. **Focused verification**: migration, RPC, host authorization, immutable
   artifact bytes, expiry, restart fence, shell fallback, stale identity,
   streams, timeout, and abort checks. E2E runs remain opt-in.

## 10. Focused verification checklist

### Plan and storage

- one Agent identity across Agent, Plan, approval, queue, and execution;
- unique artifact path per submission and byte-for-byte Markdown preservation;
- title/question stored structurally and artifact opener resolves the file;
- approve/reject-only schema and Ask default;
- absolute expiry returns `PLAN_APPROVAL_TIMEOUT`;
- one active turn, one pending approval, and one queued/running execution;
- v8-to-v10 migration and rollback;
- startup transaction interrupts prior pending/queued/running work before RPC;
- no provider/tool/queue replay after restart;
- pending interruption leaves Plan; approved interruption leaves Agent;
- scheduled Plan rejection before provider/artifact/queue work.

### Shell and process

- exact platform catalog IDs and settings validation;
- persisted unavailable ID falls back to the first available platform shell;
- turn pins effective ID/dialect and stale identity fails closed;
- Bash protocol name remains stable;
- separate ordered stdout/stderr events and bounded final result;
- exact 60-second default and 1-300 second override bounds;
- timeout and user abort terminate the complete process tree.

## 11. Acceptance evidence

The E2E plan automates these M6 scenarios: E2E-104 migration, E2E-105 host
Plan policy, E2E-106 immutable artifact approval, E2E-107 expiry, E2E-108
startup interruption, E2E-109 no replay/Agent retention, E2E-110 scheduled
rejection, E2E-111 active/configuration boundaries, E2E-112 shell selection and
fallback, E2E-113 stale shell identity, E2E-114 streaming, E2E-115 timeout,
E2E-116 process abort, and E2E-117 UX/locales.

Acceptance on 2026-08-05 combined the host-core suite (139/139 passed, including
15 focused DB tests), 97 agent-runtime tests, desktop/shared/i18n suites, full
JavaScript build/typecheck/lint, the long-timeout `test:e2e:plan` host workflow,
and the raw-CDP
`test:e2e:plan-ui` Electron workflow. The two host states that public RPC cannot
manufacture safely — late approval expiry and a previously persisted shell
becoming unavailable — are covered directly by deterministic Rust tests. The
same-Host renderer evidence covers pending restore, same-lifetime terminal
controls, stable Electron/Host identity, and rejected plus approved/completed
terminal-card absence after renderer reload. E2E-108/E2E-109 cover Host restart
interruption, stale-response rejection, and no replay.

## 12. Explicit non-goals

- a second planner Agent/model/service;
- request-changes feedback in the approval card;
- renderer/sidecar writes or replacement of plan artifacts;
- replaying any Plan work after host restart;
- automatic approval for scheduled/background Plan;
- arbitrary executable paths outside the host shell catalog;
- separate PowerShell/cmd/Git Bash protocol tools;
- executable path hashing as shell identity;
- interactive PTY behavior for the Agent Bash tool.
