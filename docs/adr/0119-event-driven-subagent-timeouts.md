# ADR 0119: Event-Driven Subagent Timeouts

- Status: Accepted for implementation; amended by ADR 0129
- Date: 2026-08-24
- Related: ADR 0062 (bounded subagents), ADR 0089 (background delegation),
  ADR 0129 (idle bounds silence, not slowness), D254

## Context

The original delegate loop used a default turn cap, so a delegate making one or
two useful calls per turn could be terminated while actively working, and nothing
distinguished an idle worker from one waiting on a long-running tool.

## Decision

A delegate carries two independent watchdogs: an idle timer and a total-runtime
timer that includes tool execution. Activity is any delegate turn, message, or
tool lifecycle event, and the idle timer pauses between `tool_execution_start` and
its matching `tool_execution_end`, so a long Bash call is governed by the tool
timeout instead of delegate idleness. A watchdog ends the delegate with
`timed_out` plus `SUBAGENT_IDLE_TIMEOUT` or `SUBAGENT_DURATION_TIMEOUT` and keeps
the latest partial assistant output, while provider failures, parent aborts, and
explicit turn caps keep their existing outcomes. `maxTurns` stays optional, where
omission, `none`, or `0` means unlimited and a positive value is a bounded
backstop; definitions may override `idle-timeout` and `max-duration` within
clamped ranges, and non-numeric values warn and fall back to defaults. The shared
status contract and delegation topology expose `timed_out`, labeled as a warning
outcome in each shipped locale.

ADR 0129 amends this record: every `AgentEvent` re-arms the idle timer, the idle
default drops to 300 seconds, and the built-ins described as unlimited carry turn
backstops. The total-duration ceiling stays.

## Consequences

- Delegates run past the old turn budget while remaining active, with idle and
  runtime failures still bounded and diagnosable.
- Timeout reports reach `TaskWait`, `TaskList`, and the topology with structured
  error codes.
- An explicit `maxTurns` keeps a deterministic hard stop for untrusted workloads.

## Alternatives

- Raise the turn cap: rejected because any fixed cap still kills active work and
  scales poorly across models.
- Use only idle time: rejected because continuous activity would run without a
  hard resource ceiling.
