# ADR 0129: The Subagent Idle Watchdog Bounds Silence, Not Slowness

- Status: Accepted for implementation (amended by ADR 0166: watchdogs no longer
  kill; the parent judges subagent lifetime)
- Date: 2026-08-27
- Related: D260 (amends D254), ADR 0119, ADR 0089

## Context

ADR 0119 replaced the delegate turn cap with an idle watchdog re-armed by an
allow-list of five event types, so liveness was decided by event kind: any other
`AgentEvent` variant was silently dropped and the intended contract went unstated.
The 600-second default was also never sized against what it measures — the wait
between a delegate's last streamed token and its next response — and it equalled
the `TaskWait` default, so a hung delegate could not settle inside one wait.

## Decision

1. Every `AgentEvent` re-arms the idle timer, a single streamed token as
   `message_update` included, so the watchdog fires on total unresponsiveness only;
   the pause between `tool_execution_start` and its matching `tool_execution_end`
   is unchanged.
2. The default idle timeout is 300 seconds, above the measured pre-token wait and
   the delegate's silent provider retry backoff and below the 600-second
   `TaskWait` default, so a stuck delegate settles as `timed_out` inside one wait.
3. `TaskWait` expiry reports "Still running after Ns" and states that this is not a
   failure and the unfinished delegates keep working.
4. The built-ins carry a turn backstop sized to their job: `explorer` 60,
   `code-reviewer` 50, `test-runner` 40, `fixer` 80, so a non-converging delegate
   ends as `truncated` with its partial report.

## Consequences

- A slow delegate is never idle-terminated; only silence expires it, and a new
  `AgentEvent` variant no longer requires touching the watchdog.
- Extreme latency outliers and long rate-limit backoff now expire at 300s rather
  than 600s, returning `timed_out` with the latest partial report.
- A hung delegate surfaces within a single `TaskWait`.

## Alternatives

- Keep the allow-list and only lower the default — rejected: liveness stays an
  enumeration that must be revisited as `AgentEvent` grows.
- Raise the idle default and `TaskWait` together — rejected: the idle window must
  stay shorter than a wait.
