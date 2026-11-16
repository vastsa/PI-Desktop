# ADR 0053: Plan checkpoint artifact, approval, and execution epoch

- Status: Accepted for implementation
- Date: 2026-07-31
- Related: ADR 0061, ADR 0064, D189
- Supersedes: ADR 0052 and D188

## Context

The previous Plan contract used an in-memory approval waiter around a structured
proposal with request-changes feedback, so there was no single inspectable plan
artifact and no defined way to interrupt an approved execution. Approval must
survive a renderer reload, while a host restart must never replay work created by
an older host process.

## Decision

### 1. One Agent and one Plan submission tool

The selector stays `Agent | Plan` with Agent as the default and one pi Agent per
session, where Plan is that same Agent in planning state exposing `Read`, `Glob`,
`Grep`, `BrowserPreview`, `Bash`, `EnterPlanMode`, and `SubmitPlan` while Write,
Edit, and plugin tools stay host-denied. The input is exactly `title`, `markdown`,
and `question`, with no `ExitPlanMode`, structured step schema, `proposedCommands`,
or `request_changes`, so a revision is a new `SubmitPlan` after rejection or
expiry.

### 2. Immutable host-written plan artifacts

For a project-bound session host-core writes the submitted Markdown bytes
unchanged to a new uniquely named artifact under `.pi/plan/` in the workspace and
records the workspace-relative path, SHA-256, and byte size in the same approval
record, leaving `title` and `question` as structured fields without wrapping,
normalizing, or replacing the bytes. A path escape, symlink ambiguity, or write
failure creates no approval or execution descriptor.

### 3. Approval and permission selection

The card shows the structured title and question, an opener for the host-created
artifact, the absolute expiry, and the current status, and offers only Approve and
Reject, where Approve requires an explicit `ask`, `accept-edits`, or `auto`
execution mode defaulting to `ask` and Reject grants nothing. The deadline is an
absolute 30-minute deadline from host creation that survives a renderer reload,
expires as `PLAN_APPROVAL_TIMEOUT`, never extends when the card reopens, and never
approves through timeout, reload, scheduled task, or stale renderer.

Completed submissions additionally render read-only historical cards, joining
returned submission call IDs to the existing approval table without rewriting the
original tool result. This is an additive read projection with no schema
migration and no execution grant.

### 4. Process-epoch fence and recovery

The single `plan_approvals` row carries `status` (`pending` → `approved` |
`rejected` | `expired` | `interrupted`) and `execution_state` (`queued` →
`running` → `completed` | `interrupted`), and approval atomically switches the
session to Agent with the selected permission mode, records `execution_id`, and
queues the execution turn; only one approval may be pending and one execution
queued or running per session. Before serving any RPC after startup, host-core
marks all prior pending approvals and queued or running executions as
`interrupted` and aborts their turns, so no approval, provider call, or tool
execution is replayed.

### 5. Turn and configuration boundaries

A session has one active turn, so a second prompt, second submission, second Plan
run, or a mode, provider, model, permission, or shell change is rejected while
that turn or run is active, and configuration is accepted only while idle.

### 6. Scheduled Plan policy

Unattended Plan execution is rejected before any provider work, artifact,
approval, or queue insertion with `PLAN_REQUIRES_INTERACTIVE_SESSION`, so a
scheduled task must be switched to Agent to run unattended.

### 7. Versioned contracts

Protocol v9 carries `SubmitPlan`, the artifact path and metadata, approve and
reject responses, the absolute expiry, execution state, shell selection, and
streamed command output, and storage schema v10 keeps the single `plan_approvals`
table with title, question, artifact fields, execution state, and the persisted
default shell through one transactional migration.

## Consequences

- Every proposal has its own host-owned file with verifiable bytes, and reload is
  recoverable without a restart replaying work.
- Rejecting is terminal, so a revision costs another model turn and another
  artifact; restart interrupts even an approved queued execution.
- Plan artifacts accumulate immutably under `.pi/plan/` and are not a
  renderer-owned draft store.

## Alternatives

- Request-changes approval: rejected because it mixed plan editing into the
  approval boundary.
- Replay a durable queue after restart: rejected because the persisted request can
  outlive the process, tool, shell, and user intent behind it.
