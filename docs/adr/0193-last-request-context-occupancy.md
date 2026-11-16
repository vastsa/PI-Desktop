# ADR 0193: Last-request occupancy in the context inspector

- Status: Accepted (amended 2026-10-11: occupancy no longer adds
  `reasoningTokens`, which the reported output already contains)
- Date: 2026-09-09
- Amends: D103, D184, D244, D347, ADR 0047, ADR 0103, ADR 0184
- Related: D355, E2E-060d, US-UI-61

## Context

The inspector mixed two token scopes: remaining capacity and used/window counts
came from the newest assistant message, while turn totals and cache figures came
from the summed visual turn, so a 55k window sat beside a 377k turn total and
looked like a leak.

## Decision

Occupancy, remaining capacity, used/window counts, turn total, provider usage
counts, and cache hit rate all read from the newest usage-bearing assistant
message, with occupancy computed as `input + output + cacheRead + cacheWrite`,
where `output` already carries reasoning tokens so `reasoningTokens` is never
added again. Completed-turn speed and the aggregate tool row still describe the
visual turn, host rollups keep additive billing, and a streaming turn without
totals does not steal the previous usage-bearing turn.

## Consequences

- Cache read stays on the same scale as the context window, so a tool-heavy turn
  no longer looks like an overflow.
- Turn-summed cache and cost remain available to the usage plugin rather than
  the occupancy ring.

## Alternatives

- Show both totals: rejected, two numbers in a compact inspector recreate the
  contradiction.
