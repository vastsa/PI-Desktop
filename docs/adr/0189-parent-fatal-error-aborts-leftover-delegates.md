# ADR 0189: Parent fatal error aborts leftover delegates

- Status: Accepted for implementation
- Date: 2026-09-08
- Related: ADR 0166, ADR 0089, D352, D328

## Context

D328 / ADR 0166 keep a durable turn open when the parent idles with running
delegates, which is right for a parent that merely stopped calling tools. After a
terminal parent error the turn ends as `error`, yet leftover delegates kept
`isRunning` true, so Continue was rejected as `AGENT_BUSY` while the conversation
looked finished.

## Decision

### 1. Parent idle still does not abort delegates

D328 is unchanged for a parent that stops calling tools without a fatal error.

### 2. A terminal parent error aborts leftover delegates

Exhausted rate limits, other terminal provider or stream errors, overflow-recovery
failure, mutation-budget termination, and rejected-prompt failures abort running
delegates, skip the resume prompt, and emit `agent_end`.

### 3. The session becomes idle for Continue

`getStatus().isRunning` ignores leftover delegates after `turnHadError`; the failed
TurnOutcomeCard stays visible and a later `agent_end` must not overwrite it.

### 4. A later prompt inherits no earlier delegates

Each `prompt()` / `executeApprovedPlan()` bumps a turn epoch, aborts runs from
earlier epochs, and auto-resumes only delegates started in the current turn.

## Consequences

- Continue is accepted after a 429 even while an unrelated subagent was running.
- Unreported delegate work is aborted instead of landing in a dead turn.
- Idle parents with live delegates still show a live turn until reports arrive.

## Alternatives

- Detach leftovers from `isRunning` without aborting: rejected because a later
  turn would race them on the workspace.
