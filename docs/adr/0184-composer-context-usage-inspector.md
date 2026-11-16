# ADR 0184: Dock the context usage inspector in the composer toolbar

- Status: Accepted (amended by D355 / ADR 0193)
- Date: 2026-09-08
- Related: D103, D184, D244, D297, D347, D355, ADR 0047, ADR 0103, E2E-060d, US-UI-61

## Context

The compact context inspector (ADR 0047, ADR 0103) hung under the newest assistant turn,
so checking remaining capacity meant finding that row again after the transcript
scrolled.

## Decision

One inspector renders in the composer right toolbar, immediately left of the combined
model × reasoning chip, hidden until the session has usage, replacing the per-row copy. It
keeps the D355 data contract — remaining capacity, used/window counts, turn total, and
exact provider input/output/cache/reasoning/hit-rate describe the newest usage-bearing
assistant message, while completed-turn speed and the aggregate tool summary describe
that visual turn, delegate usage never drives the ring, and compaction marks split
overflow-retry turns — and keeps the click and keyboard trigger, capacity ring,
viewport-aware body portal, outside-click dismissal, Escape handling, and the compact
summary with a floating-layer edge and no inner section rules (D297). Assistant meta keeps
the optional model badge and the usage-less throughput fallback and no longer hosts the
inspector, and the change is renderer only: no protocol, storage, runtime accounting, or
model metadata change.

## Consequences

- Remaining capacity stays reachable while composing, while historical turns lose their
  per-row inspector.
- Only one surface shows the numbers, so the authoritative copy is no longer ambiguous.

## Alternatives

- Keep the row inspector and add a composer entry: two surfaces with the same numbers.
- Inner hairlines between popover sections: D297 keeps an outer edge on floating layers.
