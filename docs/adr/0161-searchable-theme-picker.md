# ADR 0161: Searchable theme picker matching language

- Status: Accepted
- Date: 2026-09-05
- Decision owners: PI-Desktop desktop/settings maintainers
- Related: D316, D314, ADR 0160, D175

## Context

Settings → General → Appearance presented theme as three preview cards
(System / Light / Dark), with plugin themes wrapping into the same grid.
Language and Font are already searchable picker rows. Plugin themes make
the card grid wrap past three columns, and the visual mockups did not
scale with contributed palettes. The language picker already solved the
same growing-list problem.

## Decision

1. Theme is a searchable picker row, same anchored-menu pattern as
   Language: the trigger fills the settings control column, the menu
   portals so the settings card cannot clip it, and search filters the
   list.
2. Built-in System, Light, and Dark stay pinned at the top. Plugin
   themes follow after a divider, with the existing "Provided by …"
   hint. Search matches labels, descriptions, ids, and plugin ids.
3. `AppSettings.theme` is unchanged (`system` | `light` | `dark` |
   `plugin:<pluginId>:<themeId>`). An unavailable plugin theme still
   falls back to `system`.
4. This amends ADR 0160's clause that Appearance keeps Theme as three
   preview cards.

## Consequences

- Appearance's three rows — Theme, Language, Font — share one control
  pattern.
- Plugin themes no longer wrap a three-column card grid.
- Adding a plugin theme does not change the picker chrome.

## Alternatives

- Keep theme as wrapping preview cards: unreadable once plugins add
  more than one or two palettes, and inconsistent with Language.
- Keep mini-window mockups inside the picker rows: extra chrome for a
  choice that is already visible the moment it is selected.
