# 10. Session, Plan, and Goal State Machine

## 0. Durable operating mode versus live planning state

Each session persists `agent | plan | goal` and uses the same pi Agent. Plan
retains `planning -> awaiting_approval -> Agent queued/running`; rejecting,
expiring, or interrupting a proposal grants no execution authority. Persisted
legacy Goal approvals retain that same resolution/execution path. New Goal work
uses the independent lifecycle below, not `PlanningState`.

## Autonomous Goal lifecycle

| State | Meaning / exit |
|---|---|
| `active` | User-authorized work; admission may claim the next execution turn |
| `paused` | User pause, explicit abort, or restart; explicit user resume required |
| `blocked` | Reported blocker or execution failure; explicit user resume required |
| `completed` | Every stored criterion met and versioned model audit accepted; terminal |
| `budget_exhausted` | Next admission has no remaining allowance; user may resume with sufficient budget |
| `cancelled` | Explicit user cancellation; terminal |

Only a user-owner start or resume authorizes execution. Goal-mode selection alone
does not execute. Direct Goal-mode send starts without Plan approval. Default
budget: 20 execution turns including the initial one, not 20 tool calls or model
requests. Defaults are snapshotted from settings.defaultGoalBudget only when
created. Explicit maxTurns=null is unlimited; no maxTokens is unlimited tokens.
Existing finite goals retain their caps, even after defaults change. Neither
setting edits nor unlimited budgets grant new execution authority.
Optional token caps are soft and checked using settled parent/delegate
usage at next admission; in-flight work can overshoot.

Shared `AgentHost`/`GoalCoordinator` admission serializes user queues and Goal
continuations with user work first. Rust revision CAS and unique turn claims
prevent duplicate starts. `goal_turns` records idempotent settlement before
`agent_end`; continuation system context does not add a user transcript row.
Header pause persists finish-current-round intent without cancelling runtime;
Composer Stop and cancel persist stopped state before runtime cancellation.
An accepted Goal startup message is authorization, not an ordinary retractable
prompt. Composer Stop preserves that message and never attempts draft recovery
for its startup snapshot; ordinary prompt recovery is unchanged.

Input mode selection never pauses or resumes a Goal. Startup acceptance returns
Goal input preference to Agent; ordinary messages/Send now keep continuation alive.
A paused Goal can run ordinary Agent tasks, then resume without a mode change.
Immutable Host turn mode preserves Plan/tool policy across preference changes. Startup
pauses active goals and clears interrupted claims without replay. Resume cannot
race an unsettled claim; completed/cancelled goals cannot resume.

User-owner edit requires a nonterminal goal and revision CAS. It replaces the
objective and criteria, clears old report/audit, and preserves budget/usage/time,
active claim and lifecycle state. Opening or saving the editor never pauses or
resumes work. Visible scope updates immediately; activeScope freezes this Host
claim's objective/criteria through all its provider/tool requests. The next claim
adopts the new scope. Old-scope completion cannot complete an edited future scope.
Delete persists a cancelled logical tombstone before aborting runtime work. It
removes the current Goal presentation, not chat/todos/claims. A late report cannot
revive it; late usage settles only its original claim. A new explicit Goal may
replace unfinished work atomically and persist while the old runtime drains.
Its first claim waits for all old claims and running ordinary turns to settle.
The explicit startup prompt is queued with goalStartId; obsolete startup entries
cannot dispatch against a later replacement. New budgets/counters are independent. Notifications carry removal
identity/revision so delayed loads cannot resurrect it or erase a newer Goal.
Host-backed active time excludes paused/offline intervals; navigation preserves
it. Recovery may lose a hard-crash tail instead of inventing elapsed duration.

`GetGoal`/`UpdateGoal` are host-bound to the active session/goal/turn. Reports have
no scope, budget, pause, resume, cancel, or creation authority. A completed report
must cover exactly all stored criteria with `met` and non-empty evidence; the host
also requires a version-1 audit of the exact original objective, nonempty
requirement items all met with evidence, and no remaining work. The current
model must audit authoritative current-state evidence over the full scope,
without redefining success. Failed structural reports are correctable and do
not complete the goal. The host validates that structure, **not the truth or
semantic exhaustiveness of the model's evidence**.

Goal uses Agent's ordinary Write/Edit, Task and plugin policy, including path,
sandbox, permission, grant and rejection checks. Plan's hard denies are unchanged.
Scheduled/unattended Goal creation remains rejected. Legacy `EnterGoalMode` and
`SubmitGoal` creation is disabled; existing approval rows are never autoauthorized
or migrated into `session_goals`.

The remaining approval invariants and artifact rules below apply to Plan and
persisted **legacy Goal approvals**, not new autonomous Goal execution.

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

A turn reaches one of three terminal reasons — `completed`, `aborted`, or
`error` — matching the `aborted` / `error` rows in section 1. The terminal
reason is decided once: an abort records its decision before the cancel request
is issued, so a later `agent_end` cannot restate an aborted turn as completed.
Terminal events are attributed by turn identity, not by session: a terminal
event whose turn no longer owns the session changes neither the current turn's
state nor its resources, and late message and tool rows are still recorded as
history. The host announces the terminal state once per started turn through
the `session:turnEnded` plugin event (see ADR 0252,
`docs/adr/0252-plugin-host-turn-end-event.md`).

A steering input is judged by the same identity: one that names a turn which was
cancelled, has started finalizing, or no longer owns the session is refused as a
turn that has ended.

## 3. Transition rules

1. Only one active turn per session
2. A direct host prompt is rejected with `AGENT_BUSY` while
   running/waiting_permission. The renderer's Send-while-running path pushes
   the next prompt into the Host-owned turn queue (schema v15, D375 / D386 /
   ADR 0213) through `agent/queue/push` and mirrors the durable entries from
   `agent/event/queueChanged`; the Agent Host module releases one entry after
   `agent_end`, holds a restored queue until the owner attaches, and moves an
   entry to the head on `agent/queue/prioritize`, so normal user sends do not
   surface `AGENT_BUSY`.
3. A graceful stop completes the current assistant/tool boundary as a normal
   `completed` turn before the renderer releases a queued prompt.
4. Abort from running or waiting_permission is allowed. Renderer smart Stop
   removes an unanswered root user row and restores its session/turn-scoped
   pre-serialization composer snapshot; once assistant text, thinking, or any
   tool row begins, abort preserves the partial transcript and restores no
   draft. The snapshot keeps structured file/image references and is never
   reconstructed by parsing model-facing `@path` text.
5. A local permission remains in `waiting_permission` until explicit allow,
   deny, cancellation, or host shutdown; an explicit deny then moves to tool
   denied and the agent may continue or end based on runtime handling
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
10. Whole-session fork is idle-only. A Desktop message-scoped fork may copy
   a completed assistant prefix during a later turn, provided no indexed row in
   the prefix belongs to a running turn. The source continues; the child begins
   idle with no turn or waiting-permission state. Other busy forks return host
   `CONFLICT` / IPC `AGENT_BUSY`; native Pi keeps its ownership/idle guard.
   No refused fork produces a partial child.
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
17. A terminal parent provider/stream error aborts leftover delegates and
    returns the session to idle so Continue is accepted. Parent idle with
    running delegates still keeps the turn open (D328 / D352). System-interrupted
    delegates settle as failed and remain manually resumable; explicit Stop and
    dispose remain non-resumable cancellations.

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
  The finished assistant snapshot is checkpointed before the outbox append;
  handshake awaits that drain before a cold `session.get` (D327). Renderer
  revalidation of a running or just-completed session stitches the
  bounded durable page onto the live snapshot in chronological order so older
  live rows stay before that page and the in-flight or not-yet-flushed tail
  stays after it (D317, D324). Live provenance is cleared only once that page
  already contains every live row.
- orphaned session restore: a live JSONL whose sessions row is gone is
  reinserted at host boot and on `session.appendMessage`; a queued outbox
  drains after that restore, and `session.delete` drops that session's
  outbox entries (D318)
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
6. a fork starts as an independent idle session; a busy Desktop source can
   fork only a completed assistant prefix outside its running turn
7. a message-scoped fork excludes later rows and begins with no source runtime
   or provider-cache state
8. a running session can queue removable FIFO prompts per session; Send now
   completes the current turn at the next boundary, while immediate Abort
   leaves the queue intact
9. Plan, Goal, and Agent use one pi Agent. Plan approval resumes Agent execution;
   new Goal starts/resumes only on user authority through its independent lifecycle.
10. Plan retains hard mode denies; Goal follows ordinary Agent permission policy.
   Legacy approval resolution does not grant autonomous-loop authority.
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

## Goal live controls and private planning

Header pause leaves an active claim valid and persists pauseRequested until its
settlement; no new claim is admitted. Composer Stop uses goals.control action
stop, immediately changes status to paused, then aborts runtime execution.
Control action budget stages pendingBudget while a claim exists and applies it
at settlement before budget exhaustion/admission. Without a claim it applies
immediately and never resumes. Restart applies pending changes while clearing
interrupted claims and retains the ordinary pause/no-replay policy.

Goal EnterPlanMode/SubmitPlan control only the authorized runtime's private
read-only planning phase (no Write/Edit, Bash, plugin mutations or delegation).
SubmitPlan requires a concrete plan and self-review,
returns to execution without user approval, and grants no scope, budget, mode
or permission changes. Normal Plan approval and legacy Goal approval rows are
not reused for this phase. Distinct durable turn IDs remain separate transcript
sections without synthetic user input.
