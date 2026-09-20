# ADR 0290: Restore Resizable Sidebar Width with Collapse-Below-Threshold

- Status: Accepted
- Date: 2026-09-19
- Decision: D459
- Amends: [ADR 0141](0141-sidebar-width-resize.md) ·
  [ADR 0238](0238-three-column-width-priority.md)
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [07-ui-design-system §10](../spec/04-ux/07-ui-design-system.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-168

## Context

ADR 0141 made the expanded sidebar a persisted `240px..520px` column. D408 /
ADR 0238 later pinned that column at 275px and hid the handle so the
three-column budget could treat the left dock as a constant while MainChat
kept a 450px floor.

Users still need to widen the sidebar for long project and session labels, and
to reclaim space. The right work panel already has a pointer divider; the left
column should match that affordance. Dragging past a usable minimum should
fold the sidebar rather than leave a cramped strip.

## Decision

1. Restore ADR 0141's renderer-owned handle on the expanded sidebar's right
   edge. Pointer motion previews a width anchored at press, rounded and
   clamped to `240px..520px` (default `275px`). Pointer release persists the
   preferred width. Keyboard ArrowLeft/ArrowRight step 16px; Home and End
   select the live bounds; keyboard changes commit immediately. Escape,
   cancellation, lost capture, and unmount restore the press-time width.
2. A pointer width below `160px` collapses the sidebar immediately. Collapse
   is a user action: it does not record an automatic-yield, and it does not
   persist the in-progress width. Reopening restores the preferred expanded
   width from the start of the gesture (or the last committed value). Keyboard
   resize never collapses; `Cmd/Ctrl+B` remains the keyboard fold.
3. The live maximum is the three-column remainder after MainChat's 450px floor
   and, when the work panel occupies space, its requested width. A user-chosen
   sidebar width therefore cannot trip D408's `<= 450px` yield. Work-panel
   growth and window shrink still collapse the expanded sidebar at that
   threshold. Preview mode (MainChat unmounted) caps the sidebar so the panel
   keeps at least its 244px minimum.
4. Renderer only. No IPC, native-window bounds, host protocol, or storage
   schema change. The existing `pi.desktop.sidebarWidth` preference is the
   persistence key.

## Consequences

- Long labels and compact workspaces share one persisted width instead of a
  fixed 275px column.
- Dragging the handle left past the snap threshold folds the sidebar the same
  way the explicit collapse control does, without writing a sub-minimum width.
- MainChat's 450px floor and the work-panel yield order stay intact.

## Alternatives rejected

### Keep the D408 fixed 275px column

Rejected because it blocks the same inspection and space-reclaiming need ADR
0141 already recorded, and the live budget can cap a user-chosen width without
freezing it.

### Collapse at 240px with no snap zone

Rejected because hitting the minimum during a small adjustment would fold the
sidebar. The 160px threshold requires an explicit extra drag past the floor.

### Persist the in-progress width on collapse

Rejected because collapse is a cancel of the current gesture plus a fold. The
preferred expanded width stays the value captured at pointer-down (or the last
committed width).
