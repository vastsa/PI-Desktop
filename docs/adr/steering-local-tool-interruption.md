# ADR: Steering waits for confirmed tool settlement

- Status: Accepted (supersedes the started-tool behavior in ADR active-turn-steering)
- Date: 2026-11-06
- Related: active-turn-steering, issue #2131

## Context

An indefinitely running tool prevents accepted steering from reaching the model, while
continuing before a mutating operation stops can cause conflicting side effects.

## Decision

Accepted steering cancels local foreground Bash and read operations owned by the current
turn and reaches the model only after they settle, without Stop's bounded grace period;
unstarted calls are skipped, TaskWait yields while delegates continue, and background
commands are retained. Remote workspace calls cannot acknowledge settlement through their
abort path, so steering does not cancel them, and a shell lifecycle failure, remote failure,
or uncertain external timeout waits for explicit Stop while the UI reports the pending
operation.

## Consequences

A hung or unreachable Host may still require Stop; steering keeps the same turn, model,
workspace, and permissions, and leaves the Host's cancellation and process ownership
authoritative.
