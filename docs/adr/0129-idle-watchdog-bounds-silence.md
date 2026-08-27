# ADR 0129: The Subagent Idle Watchdog Bounds Silence, Not Slowness

- Status: Accepted for implementation
- Date: 2026-08-27
- Deciders: PI-Desktop core
- Related: D260 (amends D254), ADR 0119 (event-driven subagent timeouts),
  ADR 0089 (background delegation)

## Context

ADR 0119 replaced the delegate turn cap with an idle watchdog whose timer was
re-armed by an allow-list of five event types. The list was the problem, not the
policy: it decided liveness by event *kind*, so any `AgentEvent` variant outside
it — present or future — was silently dropped, and reading the code did not
answer the question the watchdog is supposed to answer. Whether a delegate that
streams slowly stays alive was an incidental consequence of which types happened
to be listed rather than a stated contract.

Session telemetry also showed the 600-second default was chosen without
reference to what it measures. Because the timer is re-armed by streaming and
paused across tool execution, the only interval it actually bounds is the wait
between a delegate's last streamed token and its next response. In this project
that wait measures 5.6s at p50, 13.4s at p90, 55s at p99, and 174s at p99.9 —
an order of magnitude below 600s. Meanwhile 600s equals the `TaskWait` default,
so a hung delegate could not settle inside a single wait, and the parent read an
ordinary unfinished wait as if the delegation had failed.

Separately, the built-ins carried no turn backstop at all, so a delegate that
looped without converging ran to the 6-hour duration ceiling.

## Decision

1. Every `AgentEvent` re-arms the idle timer, a single streamed token arriving
   as `message_update` included. The watchdog fires on total unresponsiveness
   and nothing else. The pause between `tool_execution_start` and its matching
   `tool_execution_end` is unchanged, as is the duration timer running through
   tool execution.
2. The default idle timeout is 300 seconds, sized from the measured 174-second
   p99.9 pre-token wait plus margin for the delegate's own provider retry
   backoff, which is silent by design. It must stay below the 600-second
   `TaskWait` default so a genuinely stuck delegate settles as `timed_out`
   inside one wait. The 21,600-second duration ceiling and the 10–21,600
   override bounds are unchanged.
3. `TaskWait` expiry reports "Still running after Ns" and states that this is
   not a failure and the unfinished delegates keep working.
4. The built-ins carry a turn backstop sized to their job: `explorer` 60,
   `code-reviewer` 50, `test-runner` 40, `fixer` 80. A non-converging delegate
   ends as `truncated` with its partial report instead of running to the
   duration ceiling.

## Alternatives considered

- **Keep the event allow-list and only lower the default:** rejected because it
  leaves liveness defined by an enumeration that must be revisited whenever
  `AgentEvent` grows a variant, and leaves the intended contract unstated.
- **Emit synthetic activity across provider retry backoff:** rejected for now.
  It is the more principled fix for the one interval the runtime itself chooses
  to wait, but it makes the watchdog blind to a provider that fails and backs
  off forever. Sizing the window above the retry envelope keeps one source of
  truth for liveness. Revisit if retry budgets grow.
- **Raise the idle default to 900s and lengthen `TaskWait`:** rejected because
  it inverts the relationship that matters — the idle window must be shorter
  than a wait, or a hang cannot surface inside one.
- **Leave the built-ins unlimited:** rejected because the duration ceiling is a
  6-hour backstop, not a convergence signal; a looping delegate should return
  its partial work in minutes.

## Consequences

- A delegate that keeps producing output is never idle-terminated, however slow
  its turn is. Only silence expires it, and the reason is legible in the code.
- Two previously-survivable classes now expire at 300s instead of 600s: extreme
  provider latency outliers and a long chain of rate-limit backoff. Both return
  `timed_out` with the latest partial report rather than being lost.
- A hung delegate surfaces within a single `TaskWait` instead of holding the
  parent for a full window and beyond.
- Adding an `AgentEvent` variant no longer requires touching the watchdog.
