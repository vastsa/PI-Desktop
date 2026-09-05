# 10. Session, Plan, and Goal State Machine

## 0. Durable operating mode versus live planning state

Each session persists exactly one operating mode: `agent | plan | goal`. There
is one
pi Agent. Live planning state and execution status are host/runtime projections.
Plan and Goal are **contract modes**: both negotiate a proposal before executing
and share one projection, one approval row, and one hard deny (**D198**). `kind`
(`plan | goal`) is what distinguishes them, and the diagram below reads the same
with Goal/`SubmitGoal` substituted for Plan/`SubmitPlan`:

```text
Agent / inactive
  -- user selects Plan while idle OR Agent calls EnterPlanMode --> Plan / planning
  -- user selects Goal while idle OR Agent calls EnterGoalMode --> Goal / planning
Plan | Goal / planning
  -- SubmitPlan | SubmitGoal (title, markdown, question) --> awaiting_approval
Plan | Goal / awaiting_approval
  -- approve(permission mode) --> Agent / queued, same Agent continues
  -- reject | expiry | abort | crash | persistence failure
       --> same contract mode / planning
Agent / queued
  -- dispatcher starts --> Agent / running
Agent / running
  -- complete | fail | abort --> Agent / inactive
```

Both contract modes retain the permission-mode selector. Their `Bash` policy is
`ask` or
`accept-edits` = confirmation and `auto` = no confirmation, so a contract mode
expresses negotiating intent but is not a strict read-only security profile.
Write/Edit and
plugin tools remain denied by host policy in every Plan or Goal permission mode.

The kinds differ only in what the contract says and what the queued execution
instruction asks for: Plan proposes ordered steps to carry out, while Goal
proposes a goal statement, acceptance criteria, and boundaries, and its
execution keeps working — choosing its own approach — until every acceptance
criterion is verified or a boundary blocks it.

Mode and configuration changes through the UI/session API are allowed only
while idle. Approval is not a generic tool permission: it is a separate
host-owned state transition. A host restart interrupts every pending approval
and queued/running execution field without replay; an already-approved
interruption keeps the durable session in Agent.

## 1. Session status

```text
idle <-> running <-> waiting_permission
           \/ aborted
           \/ error
```

| status | meaning |
|---|---|
| `idle` | no active turn |
| `running` | model/tool turn active |
| `waiting_permission` | blocked on user permission decision |
| `aborted` | terminal for current turn (then returns idle) |
| `error` | terminal for current turn (then returns idle) |

## 2. Turn lifecycle

```text
accept_prompt
 -> turn_start
 -> streaming
 -> (optional tool_loop)
   -> permission_maybe
   -> tool_exec
 -> turn_end
```

## 3. Transition rules

1. Only one active turn per session
2. A direct host prompt is rejected with `AGENT_BUSY` while
   running/waiting_permission. The renderer's Send-while-running path stores
   the next prompt in its per-session in-memory queue instead and releases it
   only after `agent_end`, so normal user sends do not surface `AGENT_BUSY`.
3. A graceful stop completes the current assistant/tool boundary as a normal
   `completed` turn before the renderer releases a queued prompt.
4. Abort from running or waiting_permission is allowed. Renderer smart Stop
   removes an unanswered root user row and restores its session/turn-scoped
   pre-serialization composer snapshot; once assistant text, thinking, or any
   tool row begins, abort preserves the partial transcript and restores no
   draft. The snapshot keeps structured file/image references and is never
   reconstructed by parsing model-facing `@path` text.
5. Permission timeout moves to tool denied, then agent may continue or end based on runtime handling
6. Session status returns to idle after terminal turn states are persisted
7. Changing the renderer's active project/session does not transition or abort
   any background session
8. A tool transition retains the originating session's persisted project root,
   or that session's own scratch root when it is temporary; it never adopts the
   newly active project's root
9. `session.endTurn` moves only a `running` turn to terminal. In that same
   transaction, unseen `completed` inserts `task.completed`, unseen `error`
   inserts `task.failed`, and a result already visible in the focused current
   chat or any `aborted` turn inserts no notification (D117). Repeated terminal
   calls are no-ops. Renderer terminal lifecycle events update the transcript
   and turn result card; the sidebar terminal mark is derived only from the
   corresponding unread notification, never from `agent_end` alone.
10. Fork is allowed only while the source is idle. The child begins idle with
   no turn or waiting-permission state. Electron returns `AGENT_BUSY` for its
   active runtime guard and normalizes the host's persisted running-turn
   `CONFLICT` fallback to the same IPC error. Neither path produces a partial
   child.
11. Supplying `throughMessageId` changes only the snapshot boundary. Assistant
    Fork/Edit still creates a new idle session id with no shared turn,
    permission wait, runtime, or provider-cache state (D134).
12. `EnterPlanMode`, `EnterGoalMode`, `SubmitPlan`, and `SubmitGoal` must be the
    only tool call in their
    assistant batch. A submit tool preserves exact Markdown bytes in a new
    host-owned `.pi/<kind>/*.md` artifact and creates one pending
    `plan_approvals` row with its `kind` plus structured title/question and
    artifact fields. A submit tool called against the other kind's mode fails
    with `PLAN_KIND_MISMATCH` and writes nothing.
13. Only a matching `plans.resolve` can settle a pending proposal. Approval
    atomically changes the durable mode to Agent, stores the selected explicit
    permission mode, assigns an execution ID, and changes the row's
    `execution_state` to `queued`.
14. Approve and reject are the only resolution actions. Rejection and expiry
    close the pending row, then return the live state to the editable
    planning state of the same contract mode
    and grant no execution tools. A pending interruption does the same; a
    queued/running interruption after approval stays Agent.
15. A second prompt, Plan or Goal submission, configuration change, or execution
    is
    rejected while the session has an active turn, pending approval, or
    queued/running execution. Configuration is accepted only while idle.
16. A later turn in the same contract mode may revise a
    rejected/expired/interrupted checkpoint and
    must create a new immutable artifact rather than overwrite the earlier
    snapshot.

## 4. Persistence points

Message persistence is two-step per 04-data-storage §5 (D119): fsync'd
transcript-file line first, index transaction second.

- user message: on accept, including attachment kind/name/MIME/size and a
  content-addressed image ref when applicable; transient base64 is never a
  persistence field
- turn run row: on start + terminal `session.endTurn` update
- notification row: same transaction as an unseen completed/error terminal
  update; never for a visible-current result or abort
- assistant/tool messages: on message_end/tool_end. Electron retains each
  in-flight tool's metadata with its owning turn until the terminal event is
  persisted; delayed cleanup is scoped to that turn so a later turn's long
  `TaskWait` cannot lose its name, args, or duration. A completed tool row is
  replayed through `message_end` as a renderer recovery path, allowing a
  reload that dropped the running row to append the terminal message.
  Renderer revalidation of a running session stitches the bounded durable page
  onto the live snapshot in chronological order so older live rows stay before
  that page and the in-flight tail stays after it (D317)
- unanswered smart Stop: mark the turn aborted through the existing lifecycle,
  then atomically rewrite the transcript to the prefix before its root user row;
  the structured composer snapshot remains renderer-memory-only
- mode/project fields: on change
- temporary-session tool binding: a path-less session uses its own
  `<data_dir>/scratch/<sessionId>` root while keeping `projectPath` absent;
  Plan/Goal workspace validation continues to require a persisted project
- Plan/Goal submission: write exact Markdown bytes to a new unique
  `.pi/<kind>/*.md`,
  record path/hash/size plus the kind and structured title/question, and insert
  a `pending`
  `plan_approvals` row before the approval event
- Plan/Goal approval: approval outcome, mode transition, permission mode,
  execution
  ID, and `queued` state in one transaction; reject/expiry/interruption retain
  the contract mode and return live planning to editable state
- startup recovery: transactionally interrupt pending approvals and
  queued/running execution states before serving RPC; abort associated running
  turns and never replay work
- fork snapshot: new transcript file plus one child session/index transaction;
  source persistence remains untouched; a message-scoped snapshot ends
  inclusively at the selected message

## 5. Acceptance

1. Busy session cannot start second concurrent turn
2. Abort is idempotent
3. waiting_permission is visible in UI status
4. sessions in two retained project tabs may run independently without
   transcript-event or workspace-root crossover
5. each unseen completed/failed turn produces exactly one notification record
   while a visible-current result or aborted turn produces none
6. an idle fork starts as an independent idle session; a busy source cannot
   produce a child
7. a message-scoped fork excludes later rows and begins with no source runtime
   or provider-cache state
8. a running session can queue removable FIFO prompts per session; Send now
   completes the current turn at the next boundary, while immediate Abort
   leaves the queue intact
9. Plan, Goal, and Agent use one pi Agent; the Composer-left mode chip, UI
   entry, and
   `EnterPlanMode`/`EnterGoalMode` converge on the same planning state, and
   approval resumes
   that Agent in Agent mode
10. Contract-mode policy permits Bash only through the selected permission mode
   and
   denies Write/Edit/plugins regardless of `auto` or session grants, in Goal
   exactly as in Plan
11. SubmitPlan/SubmitGoal writes an exact unique `.pi/<kind>/*.md` artifact with
    hash/size,
    keeps title/question structured, and only approve/reject can resolve its
    `plan_approvals` row
12. Expiry uses `PLAN_APPROVAL_TIMEOUT`; startup interruption, shell failure,
    and process recovery are fail closed, and restart does not replay pending,
    queued, or running work
13. A Goal execution reports each acceptance criterion's outcome before ending
    the turn, and a scheduled/unattended Goal run is rejected with
    `PLAN_REQUIRES_INTERACTIVE_SESSION` exactly like Plan
