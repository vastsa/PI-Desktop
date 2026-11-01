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
`cancelled`. Header pause finishes the current claimed round before pausing;
Composer Stop pauses immediately before aborting runtime work. Switching
modes changes only the input preference, not the authorized Goal lifecycle. Restart pauses active goals and clears
interrupted claims without replay. Terminal completed/cancelled goals cannot resume.

Owner-only edits may replace a nonterminal objective during a live claim without
pausing. They reset scope evidence and preserve lifecycle, claim, budget/usage/time.
Visible scope updates immediately; Host-owned activeScope freezes objective and
criteria for the current claim. Only the next Host claim adopts saved edits.
Schema v32 removes the mode-pause trigger and persists immutable turn execution
mode/binding. Native tools, plugins and permission checks use that binding,
not a mutable Composer preference or caller-supplied mode. Explicit Goal startup
conditionally resets Goal input preference to Agent; it cannot overwrite a newer
Plan/Agent selection. Ordinary messages and Send now do not pause the Goal.
New explicit Goal starts replace unfinished Goals with tombstones, preserve old
claims for late usage, and wait for old runtime/claims before dispatching the new
identity. Durable goalStartId queue entries retain explicit startup intent; they
never grant claim authority themselves or execute an obsolete startup as a later
Goal. A paused Goal resumes independently after ordinary Agent work.
Schema v31 persists pending budget changes and finish-round pause intent; both
survive restart recovery without granting execution authority. Delete
retains rows/claims for settlement but exposes an ordered identity/revision
tombstone, not a previous goal. This avoids destructive history removal and
late-event resurrection. Runtime abort follows the persisted deletion fence.
Host checkpoints active time; paused/offline time is excluded, with a possible
lost uncheckpointed crash tail rather than reconstructed downtime.

The default budget is 20 execution turns including the initial turn, not tools
or provider requests. Optional token caps use reported usage as a soft bound,
evaluated at next admission after settlement. In-flight work can overshoot. Only
the user can change per-goal limits independently or supply sufficient limits
on an explicit resume. New goals snapshot
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
The inset header tucks behind the input's intact rounded top edge; elapsed time
omits zero units and padding, for example `5m` or `1d 10h 5m 8s`. A circle-with-three-dots icon opens details; edit/delete and resume dialogs
open on demand outside the measured Composer dock. Existing sessions and legacy
approvals remain readable; there is no autoauthorization or automatic restart.
Optional token limits are not a hard billing guarantee. Evidence is model-reported.

The loopback process scenario is documented in
[E2E-GOAL-autonomous-lifecycle](../spec/06-delivery/04-e2e-test-plan.md#e2e-goal-autonomous-lifecycle).
It does not establish paid-provider, production, or live-Desktop verification.

## Live-control and autonomous-planning amendment

Budget editing is independent of resume and global defaults. It saves pending
limits while a claim is active and applies them after usage settlement, before
next admission. No model tool gains budget or lifecycle control. Keeping a second
renderer-owned budget or interrupting the current stream to enforce a new cap
would violate Host ownership and cannot retract already consumed provider usage.

Autonomous rounds are separate transcript sections keyed by durable turn identity,
not fake user rows. Goal may choose a private read-only planning phase through
EnterPlanMode and self-review a SubmitPlan without creating user approval rows.
This reuses the existing runtime and tool permission guards; user Plan contracts
remain unchanged. A user objective edit invalidates a cached internal plan.
