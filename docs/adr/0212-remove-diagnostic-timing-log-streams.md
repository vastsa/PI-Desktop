# ADR 0212: Remove diagnostic timing log streams

- Status: Accepted
- Date: 2026-09-10
- Amends: [ADR 0046](0046-categorized-process-logs.md) · D183
- Related: [Logging and observability](../spec/03-runtime/09-logging-and-observability.md)

## Context

D137/D183 added per-tool, per-model, boot-phase, and updater timing output to
diagnose a slow run. That investigation is complete and those records now only
add noise to local log directories during normal use.

## Decision

Stop emitting sidecar `[timing]` lines, host `tool timing` lines, boot-phase and
updater timing records, and renderer bootstrap timing, and remove the dedicated
`timing` log category with the `PI_DESKTOP_TIMING` suppression variable; the
updater's functional timeout stays. Lifecycle, state-change, permission, tool,
plugin, provider, persistence, updater, and error records remain, as do audit
fields and duration metadata consumed by product features or security forensics,
and timing files already in a user's data directory are left untouched.

## Consequences

- Normal launches, turns, retries, and tool calls produce fewer records and no
  dedicated timing files.
- Failures stay diagnosable through lifecycle records, error codes, audit rows,
  and the visible transcript.
- Timing-specific troubleshooting documentation is retired.
