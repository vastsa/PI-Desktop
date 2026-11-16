# ADR 0053: Plan checkpoint artifact, approval, and execution epoch

- Status: Accepted for implementation
- Date: 2026-07-31
- Supersedes: ADR 0052 and D188
- Baseline: `0.4.14`
- Protocol: v9
- Storage schema: v10

## Context

The previous Plan contract used an in-memory approval waiter around a structured
proposal and allowed request-changes feedback. It did not give the user one
exact, inspectable plan artifact or define how an approved execution could be
interrupted without replay.

## Decision

### 1. One Agent and one Plan submission tool

The product selector remains `Agent | Plan`, with Agent as the default and one
pi Agent per session. Plan is the same Agent in planning state.

The input is exactly:

```ts
type SubmitPlanInput = {
  title: string;
  markdown: string;
  question: string;
};
```

### 2. Immutable host-written plan artifacts

For a project-bound session, host-core writes the submitted Markdown bytes
unchanged to a new artifact under:

```text
<workspaceRoot>/.pi/plan/<unique-name>.md
```

The directory and filename are host-owned. Each submission gets a unique file;
an accepted submission never replaces an earlier artifact.

### 3. Approval and permission selection

The approval card displays the structured title and question, an opener for the
host-created artifact, the absolute expiry, and the current status. Opening the
artifact reads the immutable Markdown file; the card does not need to inline the
Markdown or display its hash or byte size.

The approval deadline is an absolute 30-minute deadline from host creation.
Renderer reload preserves the original deadline while the host remains alive.

### Historical display amendment (issue #933)

The live approval card remains unchanged. Completed submission rows additionally
render read-only historical cards.

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

### 5. Turn and configuration boundaries

Each session has one active turn. A second prompt, second Plan submission,
mode/provider/model/permission/shell configuration change, or second Plan run is
rejected while that turn or Plan run is active.

### 6. Scheduled Plan policy

Scheduled or unattended Plan execution is rejected before provider work,
artifact creation, approval, or queue insertion with
`PLAN_REQUIRES_INTERACTIVE_SESSION`. A scheduled task must be explicitly changed
to Agent before it can run unattended.

### 7. Versioned contracts

Protocol v9 carries `SubmitPlan`, the unique artifact path and metadata,
approve/reject responses, absolute expiry, execution state, shell selection, and
streamed command output. Storage schema v10 continues the single
`plan_approvals` checkpoint table with structured title/question, artifact
fields, execution ID/state, and the persisted default shell setting while
preserving existing transcript and session data.

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
boundary.

### Replay a durable queue after host restart

Rejected because a persisted execution request can outlive the process state,
tool identity, shell identity, and user intent that created it.

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
