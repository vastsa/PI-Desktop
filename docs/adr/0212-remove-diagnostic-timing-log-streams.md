# ADR 0212: Remove diagnostic timing log streams

- Status: Accepted
- Date: 2026-09-10
- Amends: [ADR 0046](0046-categorized-process-logs.md) · D183
- Related: [Logging and observability](../spec/03-runtime/09-logging-and-observability.md)

## Context

D137/D183 added per-tool, per-model, boot-phase, and updater timing output to
help diagnose a slow run. The investigation is complete, and those records now
create noise in local log directories during normal use.

## Decision

1. Stop emitting sidecar `[timing]` lines, host `tool timing` lines, boot-phase
   timing records, updater timing records, and renderer bootstrap timing output.
2. Remove the dedicated `timing` log category and the `PI_DESKTOP_TIMING`
   suppression environment variable. The updater's functional timeout remains.
3. Keep key lifecycle, state-change, permission, tool, plugin, provider,
   persistence, updater, and error records. Keep structured audit fields and
   UI/protocol duration metadata that are consumed by product features or
   security forensics.
4. Do not delete or migrate timing files already present in a user's local data
   directory. They are historical records.

## Consequences

- Normal launches, turns, retries, and tool calls produce fewer log records and
  no longer create dedicated timing files.
- Failures remain diagnosable through stable lifecycle records, error codes,
  tool/permission audit rows, and the visible transcript.
- Timing-specific troubleshooting scenarios and documentation are retired.
- Existing local timing files may remain until the user removes them.
