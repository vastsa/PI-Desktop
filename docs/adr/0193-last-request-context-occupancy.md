# ADR 0193: Last-request occupancy in the context inspector

- Status: Accepted (amended 2026-10-11: occupancy no longer adds
  `reasoningTokens`, which the reported output already contains)
- Date: 2026-09-09
- Deciders: PI-Desktop renderer and UX maintainers
- Amends: D103, D184, D244, D347, ADR 0047, ADR 0103, ADR 0184
- Related: D355, E2E-060d, US-UI-61

## Context

The composer inspector mixed two token scopes. Remaining capacity and the
used/window counts came from the newest assistant **message**.

## Decision

1. Occupancy, remaining capacity, used/window counts, turn total, provider
   input/output/cache/reasoning, and cache hit rate are the newest usage-bearing
   assistant message (the last model request).
2. Completed-turn generation speed and the aggregate tool row still describe the
   visual turn (every fragment and tool call between the surrounding user
   messages).
3. Host completed-turn rollups, `addUsage`, and Token Insights stay additive
   billing.
4. A later streaming turn without totals still does not steal the previous
   usage-bearing turn.

## Consequences

- Cache read stays on the same scale as the context window.
- A tool-heavy turn no longer looks like it overflowed the model window.
- Turn-summed cache and cost remain available to the usage plugin, not the
  occupancy ring.

## Rejected alternatives

- **Keep the turn sum and only relabel it:** users still compare 367k cache read
  to a 55k window in the same panel.
- **Show both last-request occupancy and turn-summed cache:** two totals in a
  compact inspector recreate the original contradiction.
