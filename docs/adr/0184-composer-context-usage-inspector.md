# ADR 0184: Dock the context usage inspector in the composer toolbar

- Status: Accepted (amended by D355 / ADR 0193)
- Date: 2026-09-08
- Deciders: PI-Desktop renderer and UX maintainers
- Amends: D103, D184, D244, ADR 0047, ADR 0103
- Related: D347, D355, E2E-060d, US-UI-61

## Context

The compact context inspector (ADR 0047, ADR 0103) hung under the newest
assistant turn. After the transcript scrolled, a routine remaining-capacity
check required hunting for that row. Collaborators agreed to move the single
entry next to the model picker instead of keeping two copies of the same
numbers.

## Decision

1. Render one context inspector in the composer right toolbar, immediately
   left of the combined model × reasoning chip. Hide it until the active
   session has usage.
2. Keep the data contract, as amended by D355: remaining capacity,
   used/window counts, turn total, and exact provider
   input/output/cache/reasoning/hit-rate describe the newest usage-bearing
   assistant message (the last model request). Completed-turn speed and the
   aggregate tool summary still describe that visual turn. A later streaming
   turn without totals does not steal that turn's tools or throughput.
   Delegate rows' usage does not drive the ring. Compaction marks still
   split overflow-retry turns so the inspector does not sum the failed
   attempt with the retry.
3. Keep the click/keyboard trigger, remaining-capacity ring, viewport-aware
   body portal, outside-click dismissal, and Escape behavior. The trigger
   shows the ring and percentage only; the redundant `Context` label is
   omitted because the accessible name already states remaining capacity.
4. Keep the compact summary contents. The heading is remaining tokens plus
   percentage. Rows below use one muted-label / tabular-value rhythm,
   separated by spacing. The popover keeps its floating-layer edge and does
   not draw inner section rules (D297).
5. Assistant meta under a completed turn keeps the optional model badge and
   the usage-less throughput fallback. It no longer hosts the inspector.
6. Renderer only: no protocol, storage, runtime accounting, or model
   metadata changes.

## Consequences

- Remaining capacity stays reachable while composing, even after the
  transcript has scrolled.
- Historical turns no longer expose a per-row inspector; the composer chip
  is the single authority for the latest usage snapshot.
- The panel still opens above the dock when space allows, because placement
  already prefers the side with room and clamps to the viewport.

## Rejected alternatives

- **Keep the message-row inspector and add a second composer entry:** two
  surfaces would show the same numbers and leave users unsure which is
  authoritative.
- **Inner hairlines between popover sections:** rejected by D297; floating
  layers keep an outer edge, not internal rules. The doubled heading rule
  is fixed by dropping the extra heading caption, not by adding borders.
