# ADR 0167: Agent-chosen Bash timeout

- Status: Accepted for implementation
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: D329, D190, D273, ADR 0054, GitHub issue #44

## Context

ADR 0054 / D190 required a 60-second default Bash timeout and rejected any
override outside 1–300 seconds. That 5-minute ceiling killed legitimate
builds, tests, and audits, and `timeout: 600` / `1800` failed immediately
with `INVALID_ARGUMENT`.

D273 already widened the schema so millisecond habits validate, then clamped
them to the same 300-second ceiling. The agent could ask for 30 minutes and
still be killed at five.

A timeout remains mandatory: every spawn needs a finite deadline, and
timeout/abort still kills the process tree. The frozen failure mode is an
unbounded hang, not the integer 300.

## Decision

1. Missing `timeout` still means exactly 60 seconds.
2. An explicit override is 1 through 21,600 seconds (6 hours). That is a
   host safety bound so RPC and the process timer stay finite, not a
   product cap the agent is expected to hit.
3. A value above 21,600 is read as milliseconds (D273), converted, and
   clamped to 21,600 seconds. In-range values, including 600 and 1800, are
   seconds.
4. Out-of-range values still fail validation and never spawn.
5. Timeout and user abort still terminate the complete process tree.

## Consequences

- `timeout: 600` / `1800` / `1800000` honour 10 and 30 minutes.
- A command with no timeout still dies at 60 seconds.
- Host-core `MAX_BASH_TIMEOUT_MS` stays in lockstep with the runtime.
