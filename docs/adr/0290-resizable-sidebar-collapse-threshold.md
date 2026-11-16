# ADR 0290: Restore Resizable Sidebar Width with Collapse-Below-Threshold

- Status: Accepted
- Date: 2026-09-19
- Decision: D459
- Amends: [ADR 0141](0141-sidebar-width-resize.md) ·
  [ADR 0238](0238-three-column-width-priority.md)
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) · E2E-168

## Context

ADR 0141 made the expanded sidebar a persisted `240px..520px` column, and D408 /
ADR 0238 pinned it at 275px with the handle hidden so the three-column budget
could treat the left dock as a constant. Users still need to widen it for long
labels and reclaim space, and dragging past a usable minimum should fold the
sidebar instead of leaving a cramped strip.

## Decision

The renderer-owned handle returns on the expanded sidebar's right edge: pointer
motion previews a width anchored at press, clamped to `240px..520px` with the
`275px` default, release persists it, ArrowLeft/ArrowRight step, Home and End
jump to the live bounds, and Escape, lost capture, or unmount restore the
press-time width. A pointer width below `160px` collapses the sidebar as a user
action without recording an automatic-yield or persisting the in-progress width,
while keyboard resize never collapses and `Cmd/Ctrl+B` stays the keyboard fold.
The live maximum is the three-column remainder after MainChat's 450px floor and
the work panel's requested width, so a chosen width cannot trip D408's yield,
while work-panel growth and window shrink still collapse the sidebar. Nothing
but the renderer changes, and `pi.desktop.sidebarWidth` remains the persistence
key.

## Consequences

- Long labels and compact workspaces share one persisted width instead of a fixed
  275px column.
- Dragging past the snap threshold folds the sidebar without writing a
  sub-minimum width.
- MainChat's 450px floor and the work-panel yield order stay intact.

## Alternatives rejected

- Keep the fixed 275px column: rejected; it blocks a need ADR 0141 already
  recorded, and the budget can cap a chosen width without freezing it.
- Persist the in-progress width on collapse: rejected; collapse cancels the
  gesture, so the preferred width stays what it was at pointer-down.
