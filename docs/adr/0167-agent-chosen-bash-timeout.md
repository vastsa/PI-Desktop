# ADR 0167: Agent-chosen Bash timeout

- Status: Accepted for implementation
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: D329, D190, D273, ADR 0054, GitHub issue #44

## Context

ADR 0054 / D190 required a 60-second default Bash timeout and rejected overrides
outside 1–300 seconds, so legitimate builds, tests, and audits died at five minutes
and D273's millisecond tolerance still clamped them to that ceiling. A timeout stays
mandatory: every spawn needs a finite deadline.

## Decision

1. Missing `timeout` still means exactly 60 seconds.
2. An explicit override is 1 through 21,600 seconds (6 hours) — a host safety bound
   keeping RPC and the process timer finite, not a product cap.
3. A value above 21,600 is read as milliseconds (D273), converted, and clamped to
   21,600 seconds; in-range values, including 600 and 1800, are seconds.
4. Out-of-range values fail validation and never spawn, and timeout or abort still
   kills the process tree.

## Consequences

`timeout: 600`, `1800`, and `1800000` honour 10 and 30 minutes, no-timeout commands
still die at 60 seconds, and Host-core `MAX_BASH_TIMEOUT_MS` stays in lockstep with
the runtime.
