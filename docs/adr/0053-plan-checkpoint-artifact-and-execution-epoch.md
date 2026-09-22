# ADR 0053: Plan checkpoint artifact, approval, and execution epoch

- Status: Accepted for implementation
- Date: 2026-07-31
- Supersedes: ADR 0052 and D188
- Baseline: `0.4.14`
- Protocol: v9
- Storage schema: v10

## Context

The previous Plan contract used an in-memory approval waiter around a
structured proposal and allowed request-changes feedback. It did not give the
user one exact, inspectable plan artifact or define how an approved execution
could be interrupted without replay. Plan approval must be durable enough for
renderer reload, but a host restart must never replay work created by an older
host process.

## Decision

### 1. One Agent and one Plan submission tool

The product selector remains `Agent | Plan`, with Agent as the default and one
pi Agent per session. Plan is the same Agent in planning state. Plan exposes
`read`, `glob`, `grep`, `browser_preview`, `bash`, `enter_plan_mode`, and
`submit_plan` (it also exposed `CompactContext` until ADR 0061 removed that
tool, which ADR 0064 restores as `new_context`); write, edit, plugin tools, and
unknown tools remain host-denied. `submit_plan` is the only assistant tool call in its batch
and is valid only for the active Plan turn.

The input is exactly:

```ts
type SubmitPlanInput = {
  title: string;
  markdown: string;
  question: string;
};
```

There is no `ExitPlanMode`, structured step schema, `proposedCommands` field,
or `request_changes` action. A revision is a new `submit_plan` after the
current proposal is rejected or expires.

### 2. Immutable host-written plan artifacts

For a project-bound session, host-core writes the submitted Markdown bytes
unchanged to a new artifact under:

```text
<workspaceRoot>/.pi/plan/<unique-name>.md
```

The directory and filename are host-owned. Each submission gets a unique file;
an accepted submission never replaces an earlier artifact. The input `title`
and `question` remain structured fields in `plan_approvals`; host-core does not
prepend a title, append a question section, normalize line endings, or add any
other wrapper to `markdown`.

Host-core validates the session root, creates the file without replacement,
flushes the exact bytes, and records the workspace-relative artifact path,
SHA-256, and byte size in the same approval record. A path escape, symlink
ambiguity, or write failure creates no approval or execution descriptor.

### 3. Approval and permission selection

The approval card displays the structured title and question, an opener for the
host-created artifact, the absolute expiry, and the current status. Opening the
artifact reads the immutable Markdown file; the card does not need to inline
the Markdown or display its hash or byte size. It has only **Approve** and
**Reject** actions. Approve requires an explicit execution permission mode:
`ask`, `accept-edits`, or `auto`; the UI selects `ask` by default. Reject never
selects or grants an execution mode. There is no feedback field and no
implicit approval from a timeout, reload, scheduled task, or stale renderer.

The approval deadline is an absolute 30-minute deadline from host creation.
Renderer reload preserves the original deadline while the host remains alive.
Expiry is recorded with the canonical error `PLAN_APPROVAL_TIMEOUT`; the
deadline never extends when the card is reopened.

### 4. Process-epoch fence and recovery

The host process has an internal boot epoch, but it is not serialized in the
database and is not a protocol field. The single `plan_approvals` row carries
both approval status and execution fields:

```text
status: pending -> approved | rejected | expired | interrupted
execution_state: queued -> running -> completed | interrupted
```

Approval atomically changes the session to Agent with the selected permission
mode, records `execution_id`, and sets `execution_state = queued`; the same
Agent then starts the execution turn. Only one Plan approval may be pending and
only one execution may be queued or running for a session.

Before serving any RPC after startup, host-core runs one transaction that marks
all prior `pending` approvals as `interrupted` and all prior `queued` or
`running` execution states as `interrupted`; associated running turns are
aborted. No approval, queue entry, provider call, or tool execution is replayed.
A pending interruption leaves the session in Plan. If approval already
committed the session to Agent, interrupting its queued or running execution
leaves the session in Agent; the user may start a new turn without automatic
Plan re-entry.

### 5. Turn and configuration boundaries

Each session has one active turn. A second prompt, second Plan submission,
mode/provider/model/permission/shell configuration change, or second Plan run
is rejected while that turn or Plan run is active. Session configuration is
accepted only while idle. Approval actions are the only controls enabled for a
pending Plan request. Cross-session work keeps the existing session-scoped
workspace and event isolation.

### 6. Scheduled Plan policy

Scheduled or unattended Plan execution is rejected before provider work,
artifact creation, approval, or queue insertion with
`PLAN_REQUIRES_INTERACTIVE_SESSION`. A scheduled task must be explicitly
changed to Agent before it can run unattended.

### 7. Versioned contracts

Protocol v9 carries `submit_plan`, the unique artifact path and metadata,
approve/reject responses, absolute expiry, execution state, shell selection,
and streamed command output. Storage schema v10 continues the single
`plan_approvals` checkpoint table with structured title/question, artifact
fields, execution ID/state, and the persisted default shell setting while
preserving existing transcript and session data. The v8-to-v10 migration is
transactional; `PRAGMA user_version = 10` is written last.

## Consequences

### Positive

- Every submitted proposal has its own host-owned file with verifiable bytes.
- Renderer reload is recoverable without making a host restart replay work.
- The Agent/Plan boundary and post-approval Agent state are explicit.
- Shell choice, output, timeout, and cancellation can share the same host audit
  and turn boundaries.

### Tradeoffs

- Rejecting a plan is terminal; revisions require another model turn and a new
  artifact.
- A host restart interrupts even an approved queued or running execution.
- Plan artifacts accumulate under `.pi/plan/`; they are immutable and are not a
  renderer-owned draft store.

## Alternatives rejected

### Request-changes approval

Rejected for this checkpoint because it mixed plan editing with the approval
boundary. Revisions are new submissions with new artifact hashes.

### Replay a durable queue after host restart

Rejected because a persisted execution request can outlive the process state,
tool identity, shell identity, and user intent that created it. Restart
recovery is interruption-only.

### Renderer-owned or sidecar-written plan files

Rejected because the host must own the workspace write, path validation, hash,
size, and approval identity.

## Related docs

- `docs/adr/0054-selectable-command-shell-catalog.md`
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
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/05-security/01-security.md`
- `docs/spec/06-delivery/02-acceptance-criteria.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D189)
