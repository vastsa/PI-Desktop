# ADR 0166: Parent-judged subagent lifetime

- Status: Accepted for implementation
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: D328, ADR 0089, ADR 0119, ADR 0129, issue discussion on
  GitHub #44 follow-on (parent closing kills unfinished delegates)

## Context

ADR 0089 made `Task` non-blocking and told the parent to `TaskWait` or
`TaskStop` before ending a turn. The safety net was to abort leftover
delegates on parent `agent_end`. ADR 0119 / ADR 0129 then armed a 300-second
idle watchdog and a 6-hour duration cap.

That combination failed in practice: the parent cannot see the delegate's
live work, `TaskWait` returns after at most 900 seconds, the model treats
that as permission to finish, and `agent_end` kills the still-running
delegate. Long compiles, tests, and audits died because the parent closed,
not because the work was done.

Prompting the model to wait again does not fix this. Waiting is an event
loop; models are not reliable event loops.

## Decision

1. **Do not time-kill a delegate.** Idle and duration watchdogs are not
   armed. `idle-timeout` / `max-duration` still parse so existing documents
   load, but they have no effect. Explicit `maxTurns` remains a definition
   backstop. Concurrency stays capped at 10.
2. **Do not abort on parent idle.** `agent_end` / `turn_end` while
   delegates are running are swallowed. The durable turn stays open.
   User Stop, `TaskStop`, runtime dispose, and a parent fatal error (D352 /
   ADR 0189) abort a delegate.
3. **Deliver reports when they finish.** After the parent loop idles with
   running delegates, the runtime waits for them and prompts the parent
   with the joined reports (not shown as a user bubble). The parent then
   judges: integrate, start more work, or `TaskStop`.
4. **Give the parent a heartbeat, not the transcript.** `TaskList` and a
   timed-out `TaskWait` include agent, status, elapsed seconds, turns, tool
   calls, and last tool name. Process rows stay out of the parent context.

## Consequences

- A long delegate can outlive the parent's last tool call. The user still
  sees a live turn (Stop remains available) until the reports are delivered
  and the parent actually finishes.
- The parent no longer has to poll correctly for the job to survive.
- A looping delegate without `maxTurns` can run until the user Stops it.
- ADR 0119 / ADR 0129 watchdog policy is withdrawn for killing. Their
  "silence vs slowness" analysis remains historical.

## Alternatives rejected

- **Progress file the parent Reads (Claude Code).** Puts live transcript
  into the parent context and requires the model to remember to poll.
- **Keep abort-on-end and only raise TaskWait.** The model still closes.
- **Survive the turn with no auto-resume.** The user has to send 继续.
