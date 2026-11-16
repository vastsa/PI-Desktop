# ADR 0161: Searchable theme picker matching language

- Status: Accepted
- Date: 2026-09-05
- Related: D316, D314, ADR 0160, D175

## Context

Appearance showed theme as three preview cards with plugin themes wrapped into the
same grid, which breaks past three columns, while Language and Font were already
searchable picker rows.

## Decision

1. Theme becomes a searchable picker row on the Language pattern: the trigger sizes to
   the current label, the menu portals so the card cannot clip it, and search filters
   the list.
2. System, Light, and Dark stay pinned on top; plugin themes follow a divider under the
   host "Provided by" plugin hint, and search matches labels, descriptions, ids, and
   plugin ids.
3. `AppSettings.theme` is unchanged (`system` | `light` | `dark` |
   `plugin:<pluginId>:<themeId>`), and an unavailable plugin theme falls back to
   `system`.
4. This amends ADR 0160's clause that Appearance keeps Theme as three cards.

## Consequences

- Appearance's three rows share one control pattern.
- Plugin themes no longer wrap a card grid.
- Adding a plugin theme leaves the picker chrome unchanged.
