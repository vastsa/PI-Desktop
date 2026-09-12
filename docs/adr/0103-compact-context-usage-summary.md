# ADR 0103: Compact context usage summary

- Status: Accepted (amended by D347 / ADR 0184 and D355 / ADR 0193)
- Date: 2026-08-18
- Deciders: PI-Desktop renderer and UX maintainers
- Amends: D103, D184, ADR 0047

## Context

The context usage inspector exposed useful token data, but its default panel
became a dense diagnostic report: stacked KPI cards, multiple source badges,
provider rows, explanatory estimate copy, and one visual row for every tool.
That made a quick capacity check compete with the conversation.

## Decision

1. Keep the existing click/keyboard trigger, remaining-capacity state,
   viewport-aware body portal, outside-click dismissal, and Escape behavior.
2. Keep the panel's core summary: remaining tokens and percentage,
   used/window counts, turn total, completed-turn generation speed, exact
   provider usage values, aggregate tool types/calls/tokens, and the newest
   compaction summary when present. D355 scopes occupancy, turn total, and
   provider values to the last model request; speed and tools stay the
   visual turn.
3. Render the turn and speed values as unboxed inline stats. Render provider and
   tool usage as two compact summary rows without section cards or source
   badges. The `~` marker on the aggregate tool total remains the estimate
   signal.
4. Remove per-tool rows, share bars, the provider/tool source badges, the
   explanatory estimate paragraph, and the used-capacity meter from the
   default panel. The underlying usage aggregation and persistence remain
   unchanged, so this is renderer-only presentation work.
5. Keep the trigger and panel accessible: localized labels, dialog semantics,
   keyboard activation, focus return on Escape/outside dismissal, and collision-
   aware placement remain unchanged.

## Consequences

- A routine context check fits in a short, scannable panel instead of a tall
  diagnostic list.
- Exact provider data and aggregate tool cost remain visible, while detailed
  per-tool attribution is no longer part of the default surface.
- No host protocol, storage schema, runtime accounting, or model metadata
  contract changes.
- The E2E and component specifications must validate the compact summary rather
  than the removed diagnostic rows.

## Rejected alternatives

- **Keep all rows and only reduce font size:** preserves the density problem and
  makes the panel harder to scan.
- **Remove tool usage entirely:** loses the useful signal that tools contributed
  to a large turn; the aggregate row keeps that signal at low visual cost.
- **Move every detail behind a second disclosure immediately:** adds another
  interaction to a status check and is deferred until users demonstrate a need
  for drill-down attribution.
