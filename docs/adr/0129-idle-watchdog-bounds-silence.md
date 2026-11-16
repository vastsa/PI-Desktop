# ADR 0129: The Subagent Idle Watchdog Bounds Silence, Not Slowness

- Status: Accepted for implementation (amended by ADR 0166: watchdogs no longer
  kill; the parent judges subagent lifetime)
- Date: 2026-08-27
- Deciders: PI-Desktop core
- Related: D260 (amends D254), ADR 0119 (event-driven subagent timeouts),
  ADR 0089 (background delegation)

## Context

ADR 0119 replaced the delegate turn cap with an idle watchdog whose timer was
re-armed by an allow-list of five event types. The list was the problem, not the
policy: it decided liveness by event *kind*, so any `AgentEvent` variant outside
it — present or future — was silently dropped, and reading the code did not
answer the question the watchdog is supposed to answer.

## Decision

1. Every `AgentEvent` re-arms the idle timer, a single streamed token arriving
   as `message_update` included.
2. The default idle timeout is 300 seconds, sized from the measured 174-second
   p99.9 pre-token wait plus margin for the delegate's own provider retry
   backoff, which is silent by design.
3. `TaskWait` expiry reports "Still running after Ns" and states that this is
   not a failure and the unfinished delegates keep working.
4. The built-ins carry a turn backstop sized to their job: `explorer` 60,
   `code-reviewer` 50, `test-runner` 40, `fixer` 80.

## Alternatives considered

- **Keep the event allow-list and only lower the default:** rejected because it
  leaves liveness defined by an enumeration that must be revisited whenever
  `AgentEvent` grows a variant, and leaves the intended contract unstated.
- **Emit synthetic activity across provider retry backoff:** rejected for now.
- **Raise the idle default to 900s and lengthen `TaskWait`:** rejected because
  it inverts the relationship that matters — the idle window must be shorter
  than a wait, or a hang cannot surface inside one.
- **Leave the built-ins unlimited:** rejected because the duration ceiling is a
  6-hour backstop, not a convergence signal; a looping delegate should return
  its partial work in minutes.

## Consequences

- A delegate that keeps producing output is never idle-terminated, however slow
  its turn is.
- Two previously-survivable classes now expire at 300s instead of 600s: extreme
  provider latency outliers and a long chain of rate-limit backoff.
- A hung delegate surfaces within a single `TaskWait` instead of holding the
  parent for a full window and beyond.
- Adding an `AgentEvent` variant no longer requires touching the watchdog.
