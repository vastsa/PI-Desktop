# ADR 0103: Compact context usage summary

- Status: Accepted (amended by D347 / ADR 0184 and D355 / ADR 0193)
- Date: 2026-08-18
- Amends: D103, D184, ADR 0047

## Context

The context usage inspector held useful token data, but its default panel became
a dense diagnostic report of stacked KPI cards, source badges, provider rows,
explanatory copy, and one row per tool, so a quick capacity check competed with
the conversation.

## Decision

Keep the existing trigger, dismissal behavior, and accessible dialog semantics,
and keep the core summary: remaining tokens and percentage, used and window
counts, turn total, completed-turn generation speed, exact provider usage, and
aggregate tool types, calls, and tokens. D355 scopes occupancy, turn total, and
provider values to the last model request, while speed and tools stay the visual
turn. Turn and speed render as unboxed inline stats, provider and tool usage as
two compact summary rows, and the `~` marker keeps signalling an estimated tool
total. Per-tool rows, share bars, source badges, the estimate paragraph, and the
used-capacity meter leave the default panel even though aggregation and
persistence are unchanged: this is renderer-only presentation work.

## Consequences

- A routine context check fits a short, scannable panel.
- Exact provider data and aggregate tool cost stay visible; per-tool attribution
  is no longer a default surface.
- No host protocol, storage schema, accounting, or model metadata contract
  changes, and E2E and component specifications follow the compact summary.

## Alternatives

- Keep every row and shrink the type: rejected because the density problem and
  poor scannability remain.
- Remove tool usage entirely: rejected because the aggregate row keeps that signal
  cheaply.
