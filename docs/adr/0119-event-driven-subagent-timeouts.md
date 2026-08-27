# ADR 0119: Event-Driven Subagent Timeouts

- Status: Accepted for implementation; amended by ADR 0129
- Date: 2026-08-24
- Deciders: PI-Desktop core
- Related: D254, ADR 0062 (bounded subagents), ADR 0089 (background delegation),
  ADR 0129 (idle bounds silence, not slowness)

> **Amended by ADR 0129.** The event allow-list in decision 2 is superseded:
> every `AgentEvent` now re-arms the idle timer, and the idle default is 300
> seconds rather than 600. The built-ins named in decision 4 as unlimited now
> carry turn backstops. The rejection of "use only idle time" below concerns
> dropping the total-duration ceiling, which ADR 0129 keeps.

## Context

The original delegate loop used a default turn cap. A delegate that made one
or two useful tool calls per turn could therefore be terminated while it was
actively working, and there was no way to distinguish a genuinely idle worker
from one waiting on a long-running tool.

## Decision

1. A delegate has two independent watchdogs: 600 seconds without activity and
   21,600 seconds of total runtime. The total timer includes tool execution.
2. Activity is any delegate turn, message, or tool lifecycle event. The idle
   timer is paused between `tool_execution_start` and its matching
   `tool_execution_end`, so a long Bash call is governed by the tool timeout,
   not by delegate idleness.
3. A watchdog terminates the delegate with `timed_out` and one of
   `SUBAGENT_IDLE_TIMEOUT` or `SUBAGENT_DURATION_TIMEOUT`. The report carries
   the latest partial assistant output when one exists. Provider failures,
   parent aborts, and explicit turn caps retain their existing outcomes.
4. `maxTurns` is optional. Omission, `none`, and `0` mean unlimited turns;
   positive explicit values remain a bounded backstop, capped at 80.
5. Definitions may override `idle-timeout` and `max-duration`. Idle values are
   clamped to 10–21,600 seconds and duration values to 60–21,600 seconds;
   non-numeric values warn and use the defaults.
6. The built-in `explorer` gains `Bash` for bounded read-only inspection such
   as `git log`; `code-reviewer` remains read-only. Because Bash can mutate,
   Explorer continues to use the existing mutation/permission classification.
7. The shared status contract and desktop topology expose `timed_out`; the
   renderer labels it in English and Simplified Chinese and presents it as a
   warning outcome.

## Alternatives considered

- **Raise the turn cap:** rejected because any fixed cap still terminates an
  actively working delegate and scales poorly across models and tool density.
- **Use only a total duration:** rejected because a provider or delegate can
  remain stuck indefinitely while still below the overall ceiling.
- **Use only idle time:** rejected because continuous model/tool activity could
  otherwise run without a hard resource ceiling.
- **Keep Explorer read-only without Bash:** rejected because it prevents
  harmless repository inspection commands that the native search tools cannot
  express; the existing permission path remains authoritative for Bash.

## Consequences

- Delegates can run past the previous 20–24 turn behavior when they remain
  active, while idle and total-runtime failures remain bounded and diagnosable.
- Timeout reports are visible to `TaskWait`, `TaskList`, and the delegation
  topology, including their structured error codes and timing log entries.
- A definition that explicitly sets `maxTurns` retains a deterministic hard
  stop for specialized or untrusted workloads.
