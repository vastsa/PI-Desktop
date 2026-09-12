# ADR 0189: Parent fatal error aborts leftover delegates

- Status: Accepted for implementation
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: D352, D328, ADR 0166, ADR 0089, E2E-155

## Context

D328 / ADR 0166 keep a durable turn open when the parent *idles* with
running delegates, then resume the parent with their reports. That path is
correct for a parent that stopped calling tools.

A terminal parent provider error is different. After a 429 budget is
exhausted, Electron already finishes the durable turn as `error` and the
renderer shows Continue. Leftover delegates — often on another model that
is not rate-limited — kept `isRunning` true, so Continue was rejected as
`AGENT_BUSY` (`session already has an active turn`). The main conversation
looked finished while the sidecar was still busy.

## Decision

1. **Parent idle still does not abort delegates.** D328 is unchanged for a
   parent that stops calling tools without a fatal error.
2. **A terminal parent error does abort leftover delegates.** Exhausted
   rate limits, other terminal provider/stream errors, overflow-recovery
   failure, mutation-budget termination, and rejected-prompt failures abort
   running delegates, skip the resume prompt, and emit `agent_end`.
3. **The session becomes idle for Continue.** `getStatus().isRunning` does
   not count leftover delegates after `turnHadError`. The failed
   TurnOutcomeCard stays visible; a later `agent_end` must not overwrite it
   with `completed`.
4. **A later parent prompt does not inherit previous-turn delegates.** Each
   `prompt()` / `executeApprovedPlan()` bumps a turn epoch, aborts leftover
   runs from earlier epochs, and only auto-resumes delegates started in the
   current turn.

No IPC, storage, or host-protocol change.

## Consequences

- Continue after a 429 (or other terminal parent error) is accepted even if
  a Gemini (or other) subagent was still running.
- Work those leftover delegates had not yet reported is aborted rather than
  written into a dead parent turn.
- Parent idle with live delegates still shows a live turn until reports are
  delivered.

## Alternatives rejected

- **Keep leftover delegates running after parent error.** The session stays
  busy and Continue is `AGENT_BUSY`.
- **Detach leftover delegates from `isRunning` without aborting.** A later
  Continue turn would race them on the workspace.
