# ADR 0166: Parent-judged subagent lifetime

- Status: Accepted for implementation
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: D328, ADR 0089, ADR 0119, ADR 0129, issue discussion on
  GitHub #44 follow-on (parent closing kills unfinished delegates)

## Context

ADR 0089 made `Task` non-blocking and told the parent to `TaskWait` or
`TaskStop` before ending a turn. The safety net was to abort leftover delegates
on parent `agent_end`.

## Decision

1. **Do not time-kill a delegate.** Idle and duration watchdogs are not armed.
2. **Do not abort on parent idle.** `agent_end` / `turn_end` while delegates are
   running are swallowed.
3. **Deliver reports when they finish.** After the parent loop idles with
   running delegates, the runtime waits for them and prompts the parent with the
   joined reports (not shown as a user bubble).
4. **Give the parent a heartbeat, not the transcript.** `TaskList` and a
   timed-out `TaskWait` include agent, status, elapsed seconds, turns, tool
   calls, and last tool name.

## Consequences

- A long delegate can outlive the parent's last tool call.
- The parent no longer has to poll correctly for the job to survive.
- A looping delegate without `maxTurns` can run until the user Stops it.
- ADR 0119 / ADR 0129 watchdog policy is withdrawn for killing.

## Alternatives rejected

- **Progress file the parent Reads (Claude Code).** Puts live transcript into
  the parent context and requires the model to remember to poll.
- **Keep abort-on-end and only raise TaskWait.** The model still closes.
- **Survive the turn with no auto-resume.** The user has to send 继续.
