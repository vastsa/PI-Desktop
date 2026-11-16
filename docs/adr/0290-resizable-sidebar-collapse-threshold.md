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

ADR 0141 made the expanded sidebar a persisted `240px..520px` column. D408 / ADR
0238 later pinned that column at 275px and hid the handle so the three-column
budget could treat the left dock as a constant while MainChat kept a 450px
floor.

## Decision

1. Restore ADR 0141's renderer-owned handle on the expanded sidebar's right
   edge.
2. A pointer width below `160px` collapses the sidebar immediately.
3. The live maximum is the three-column remainder after MainChat's 450px floor
   and, when the work panel occupies space, its requested width.
4. Renderer only. No IPC, native-window bounds, host protocol, or storage schema
   change.

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
sidebar.

### Persist the in-progress width on collapse

Rejected because collapse is a cancel of the current gesture plus a fold.
