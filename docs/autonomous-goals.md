# Run an autonomous goal

Goal keeps working toward the complete original objective across execution turns.
It uses normal tool permissions. The current model executes and audits the work;
its completion report is not independent host verification.

## Set defaults and start

1. In **Settings → AI**, immediately below **Default mode**, find **Goal budget**:
   one row with **Turns** and **Tokens** inputs. Positive whole turns up to 10,000
   and positive safe whole token counts are finite caps; every other input becomes
   **Unlimited** on blur/Enter, without helper, validation or saved text. Inputs
   match Default mode height. Failed saves restore persisted values and log an error.
2. Defaults remain **20 turns** (including the initial execution turn), with no
   token cap. Changing defaults alone never starts work.
3. Choose **Goal** in the conversation mode menu. Selection and setting changes
   alone never start execution. There is no permanent setup card in the chat.
4. Describe the full objective and boundaries, choose Ask / Accept edits / Auto,
   then send. This explicit send starts the goal without a separate Plan approval.

One execution turn can contain several provider requests and tools. The host
snapshots defaults when a new goal is created; changing settings does not modify
an existing goal or authorize a resume. A finite token cap is **soft**: reported
parent/delegate usage is settled and checked before the next admission. In-flight
work may overshoot. Unlimited does not remove provider quotas, context/output
limits, existing retry limits, ordinary permissions, or user controls.

## Inspect and control a goal

An input-attached, single-line header shows status, an abbreviated objective and
active elapsed time as `00h00m00s` in every language. The header is narrower than
the input and tucks behind its intact rounded top edge. Edit, Pause/Resume, Delete
and Details are accessible icon controls. Details uses a circle containing three dots.
Whenever a current Goal exists, its header replaces
the visible task dock; the AI's stored todos remain unchanged and return after
Goal deletion. Merely selecting Goal mode does not hide tasks.

Use **Details** for a bounded dialog with the full objective,
stored budget, usage, progress, criterion evidence, completion audit and stop reason.
Dialogs do not increase the input dock's height.

| State | What you can do |
| --- | --- |
| Active | Pause, edit (pauses first), or delete; normal tool approvals still apply |
| Paused / blocked | Edit, explicitly resume under the existing budget, or delete |
| Budget exhausted | Edit, adjust the total budget and explicitly resume, or delete |
| Completed / cancelled | Inspect retained evidence or delete; no resume/edit |

Editing first pauses and waits for the current execution claim to settle. Saving
replaces the objective and derived criteria, clears prior progress/outcomes/audit,
and preserves consumed usage, elapsed time and budget. It stays paused until an
explicit resume. Delete stops and removes the current Goal, not chat or task
history. Old claims remain available for safe late settlement without resurrecting
the removed Goal or exposing an older Goal as current.
The removal confirmation has one bottom Close action, no duplicate header Close.
Escape and Close dismiss without changing the Goal.


Elapsed time is accumulated by the host while the Goal is active. Paused/offline
time is excluded; switching pages does not reset it. Historical goals start at
zero rather than inventing time. After a hard crash, the uncheckpointed active
tail may be lost; recovery does not add downtime. Forward host-clock corrections
may increase the active interval; this is a lifecycle display, not billing time.

To revise a live goal's budget, first pause and wait for the active claim to
settle. The resume dialog shows used amounts and the **new total cap**, not an
additional allowance. Finite caps must exceed consumption. Invalid, zero or blank
inputs mean unlimited, matching settings; resume still needs explicit confirmation.
Only confirmation changes the current goal; dismissing the dialog does nothing.
Ordinary resume retains the stored budget, not new global defaults. Reload is
available when a control fails or its revision is stale.

## Understand completion

The current model must derive checks from the **entire original objective** and
referenced requirements, inspect authoritative current files/results/runtime or
rendered artifacts, and match evidence coverage to each claim. A prior summary,
intent, plan update, or a narrow green test is not proof of the full objective.

Missing, contradictory, weak or uncertain evidence is not achieved. The model
must continue substantive permitted work and reverify, or report a genuine
blocker without claiming completion. It may not narrow the goal to what it has
already implemented, lower the standard, or count an unfinished deliverable as
success. A natural-language final answer, finished turn, checked todo list,
budget exhaustion, or provider stop reason cannot complete the goal.

New completed reports require a versioned audit against the exact original
objective, nonempty requirement checks all reported met with concrete evidence,
no remaining work, and complete coverage of all stored acceptance criteria. The
host validates this structure and the goal/turn identity before saving completed
and preventing another autonomous admission. Malformed reports can be corrected;
stale/stopped claims remain denied. The host does **not** infer truth or prove
that a model-derived requirements list is exhaustive. Different models may still
misjudge evidence or omit a requirement.

## Stop, recover, and preserve history

Pause/cancel intent is persisted before runtime cancellation. Queued user work
wins over continuation and uses the same budget; internal continuations never
become fake user transcript rows. Switching away pauses active Goal; switching
back does not resume. Host restart pauses unfinished active work without replay.
Only an explicitly authorized user owner may start/resume or change its budget.

Older finite budgets retain their numeric values; they do not become unlimited.
Historical completed/cancelled reports stay readable without fabricated audits
or execution. An older unfinished goal uses the new audit rules after explicit
resume. Storage upgrades are backed up; using a pre-upgrade binary on the new
format is not a supported downgrade path.

Historical Goal approval artifacts remain readable with their original
approve/reject/execute semantics. They do not acquire autonomous authority.
`EnterGoalMode` and `SubmitGoal` cannot create new goals. Plan remains a separate
workflow for reviewing an implementation checkpoint before execution.
