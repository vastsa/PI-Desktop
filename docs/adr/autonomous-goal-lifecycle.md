# ADR: Autonomous Goal lifecycle

- Status: Implemented candidate
- Decision ID: `autonomous-goal-lifecycle`
- Supersedes: D198 for new Goal creation/execution; preserves existing approval data
- Related: [state machine](../spec/03-runtime/10-session-state-machine.md),
  [user guide](../autonomous-goals.md)

## Context

The previous Goal mode reused Plan approval artifacts and transitioned to Agent
for execution. That represents an approved one-shot contract, not a durable,
budgeted loop with explicit owner controls. Reusing its approval state for new
autonomy would confuse old consent with permission to keep launching turns.

## Decision

Separate the Goal contract into `packages/shared/src/types/goals.ts` and the
Rust-owned domain in `crates/host-core/src/goals.rs`. Schema v28 adds
`session_goals` and `goal_turns`, with a v27 backup, revision checks, unique claims,
one unfinished goal per session and idempotent usage settlement. Schema v29
adds nullable audit_json with a v28 backup and gates explicit unlimited budgets;
legacy reports and numeric caps are preserved without inferred authorization.
Schema v30 adds logical deletion and active-time checkpoints with a v29 backup.
Rust remains the sole persistence authority; no renderer database or second engine.

Only a user owner can start or resume. A direct send in Goal mode starts without
Plan approval; selecting Goal alone does not execute. Scheduled automation is
still disallowed. `EnterGoalMode` and `SubmitGoal` cannot create new goals.
Existing `kind = goal` approvals retain read/resolve/execute semantics unchanged;
no migration creates autonomous authority or replays an approval.

Shared `AgentHost` and `GoalCoordinator` own Desktop/headless admission, prioritize
queued user work and acquire revision-CAS turn claims. Runtime continuations use
host-owned system provenance, not fabricated user messages. Parent and delegate
usage settle idempotently before `agent_end` can release the next admission.

States are `active`, `paused`, `blocked`, `completed`, `budget_exhausted`, and
`cancelled`. Persist pause/cancel intent before cancelling runtime work. Switching
away pauses; switching back is not resume. Restart pauses active goals and clears
interrupted claims without replay. Terminal completed/cancelled goals cannot resume.

Owner-only edit requires a stopped nonterminal Goal without an active claim;
it resets scope evidence and stays paused, preserving budget/usage/time. Delete
retains rows/claims for settlement but exposes an ordered identity/revision
tombstone, not a previous goal. This avoids destructive history removal and
late-event resurrection. Runtime abort follows the persisted deletion fence.
Host checkpoints active time; paused/offline time is excluded, with a possible
lost uncheckpointed crash tail rather than reconstructed downtime.

The default budget is 20 execution turns including the initial turn, not tools
or provider requests. Optional token caps use reported usage as a soft bound,
evaluated at next admission after settlement. In-flight work can overshoot. Only
the user can supply a sufficient revised budget on resume. New goals snapshot
validated settings.defaultGoalBudget. maxTurns=null is explicit unlimited turns;
no maxTokens is unlimited tokens. Defaults remain 20/no token cap when absent.
Neither settings changes nor unlimited caps authorize execution or mutate an
existing goal. Supplied budgets missing maxTurns are rejected, not made unlimited.

Goal uses ordinary Agent tool policy, including writes, delegation and plugins.
Path/sandbox/permissions/grants/rejection remain authoritative. Plan keeps its
hard mode restrictions. Model-facing `GetGoal` and `UpdateGoal` are bound to the
active session/goal/turn outside model arguments; no creation, scope, budget,
pause/resume/cancel authority is exposed. Completed requires exactly all stored
criteria reported met with non-empty evidence. That is validation of a model
report, **not independent host verification of success**. New completion reports
also require a version-1 audit bound to the original objective, nonempty unique
requirement checks all reported met with evidence, and empty remaining work.
The same model audits current-state evidence for the whole original scope.
Recoverable validation errors permit correction; persistence/identity failures
remain fail closed. Older reports remain readable without fabricated audits.

## Alternatives

- Keep Plan approval as the new loop's authority: conflates historical approval
  with ongoing consent and cannot express independent pause/budget state safely.
- Let the model create/resume goals or extend budgets: crosses the user-authority
  boundary and makes reported progress a source of execution permission.
- Count tools or hard-stop at a token estimate: tool calls are not execution
  turns, and provider/delegate usage is only authoritative after reporting.

## Consequences

Goal has a one-line input-attached header with elapsed time and icon controls.
While a current Goal exists, TaskDock presentation is suppressed without deleting
AI todos. Deleting the current Goal restores ordinary task display. Settings → AI
has one compact Goal budget row: non-cap inputs normalize per field to unlimited
on blur/Enter without helper, validation or save messages. No switches/advanced row.
The inset header tucks behind the input's intact rounded top edge; time remains
`00h00m00s`. A circle-with-three-dots icon opens details; edit/delete and resume dialogs
open on demand outside the measured Composer dock. Existing sessions and legacy
approvals remain readable; there is no autoauthorization or automatic restart.
Optional token limits are not a hard billing guarantee. Evidence is model-reported.

The loopback process scenario is documented in
[E2E-GOAL-autonomous-lifecycle](../spec/06-delivery/04-e2e-test-plan.md#e2e-goal-autonomous-lifecycle).
It does not establish paid-provider, production, or live-Desktop verification.
