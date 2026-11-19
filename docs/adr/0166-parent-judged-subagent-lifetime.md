# ADR 0166: Parent-judged subagent lifetime

- Status: Accepted for implementation
- Date: 2026-09-06
- Related: D328, ADR 0089, ADR 0119, ADR 0129, GitHub #44 follow-on

## Context

ADR 0089 made `Task` non-blocking and told the parent to converge before ending
a turn, with aborting leftover delegates as the safety net, and ADR 0119 /
ADR 0129 armed idle and duration watchdogs. In practice long compiles, tests,
and audits died because the parent closed, not because the work was done, and
prompting the model to wait longer cannot fix an event loop it cannot run.

## Decision

Do not time-kill a delegate: idle and duration watchdogs are not armed, though
`idle-timeout` / `max-duration` still parse as inert so old documents load,
explicit `maxTurns` remains a backstop, and concurrency stays capped at 10. Do
not abort on parent idle: `agent_end` / `turn_end` with running delegates are
swallowed and the durable turn stays open, while user Stop, `TaskStop`, runtime
dispose, and a parent fatal error (D352 / ADR 0189) still abort. Deliver the
joined reports when delegates finish and let the parent judge, and give the
parent a heartbeat through `TaskList` and a timed-out `TaskWait` rather than
transcript rows.

## Consequences

- A delegate can outlive the parent's last tool call while the user still sees a
  live turn with Stop available.
- The parent no longer has to poll correctly for the job to survive.
- A looping delegate without `maxTurns` runs until the user stops it, and the
  watchdog killing policy of ADR 0119 / ADR 0129 is withdrawn.

## Alternatives

- A progress file the parent reads: rejected, it puts live transcript into the
  parent context and still depends on the model remembering to poll.
- Survive the turn without auto-resume: rejected, the user would have to send
  继续 manually.
