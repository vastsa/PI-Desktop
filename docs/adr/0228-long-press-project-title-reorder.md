# ADR 0228: Long-press the project title to reorder

- Status: Accepted (amended by ADR 0229)
- Date: 2026-09-11
- Related: D402, ADR 0227, E2E-253

## Context

ADR 0227 put renderer-local manual project order behind a hover/focus grip that took
a leading column, stayed hidden until hover, and made reordering a second control
beside the title.

## Decision

Retained groups render no reorder grip, and the title is the reorder control: a still
press arms a pointer reorder, movement before the delay cancels it so a click still
activates the project, an armed move highlights another group in the same pinned or
archived bucket, release inserts before or after by vertical midpoint, and Escape
cancels without writing order. ArrowUp/ArrowDown on the focused title stays the
keyboard path, and persistence keeps contiguous normalized-path `order` values with
`projectSort: "manual"` in renderer-local sidebar preferences.

## Consequences

- Reorder needs no dedicated handle, and long-press disambiguates a title that also
  clicks.
- Keyboard users keep ArrowUp/ArrowDown on the same title button.
