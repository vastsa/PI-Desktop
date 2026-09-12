# ADR 0193: Last-request occupancy in the context inspector

- Status: Accepted
- Date: 2026-09-09
- Deciders: PI-Desktop renderer and UX maintainers
- Amends: D103, D184, D244, D347, ADR 0047, ADR 0103, ADR 0184
- Related: D355, E2E-060d, US-UI-61

## Context

The composer inspector mixed two token scopes. Remaining capacity and the
used/window counts came from the newest assistant **message**. Turn total,
input, output, cache read/write, reasoning, and cache hit rate came from
the summed visual **turn** — every model call in a tool loop.

That made a 55k window sit next to a 367k cache-read total and a 377k turn
total after nine tool calls. The numbers were billed correctly and still
looked like a leak. OpenCode's context widget and compaction check use only
the last assistant message:

`input + output + reasoning + cache.read + cache.write`

## Decision

1. Occupancy, remaining capacity, used/window counts, turn total, provider
   input/output/cache/reasoning, and cache hit rate are the newest
   usage-bearing assistant message (the last model request). Occupancy is
   `input + output + reasoning + cacheRead + cacheWrite` on that message.
2. Completed-turn generation speed and the aggregate tool row still describe
   the visual turn (every fragment and tool call between the surrounding
   user messages).
3. Host completed-turn rollups, `addUsage`, and Token Insights stay additive
   billing. This change is renderer presentation of parent `message.usage`.
4. A later streaming turn without totals still does not steal the previous
   usage-bearing turn. Delegate rows still do not drive the ring.

## Consequences

- Cache read stays on the same scale as the context window.
- A tool-heavy turn no longer looks like it overflowed the model window.
- Turn-summed cache and cost remain available to the usage plugin, not the
  occupancy ring.

## Rejected alternatives

- **Keep the turn sum and only relabel it:** users still compare 367k cache
  read to a 55k window in the same panel.
- **Show both last-request occupancy and turn-summed cache:** two totals in
  a compact inspector recreate the original contradiction.
