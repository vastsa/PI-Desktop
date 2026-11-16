# ADR 0141: Make Expanded Sidebar Width User-Resizable

- Status: Accepted (amended by [ADR 0290](0290-resizable-sidebar-collapse-threshold.md))
- Date: 2026-09-01

## Context

A fixed expanded sidebar width makes long project names and session titles hard
to inspect, while a permanently wider sidebar wastes space in compact
workspaces.

## Decision

The expanded sidebar exposes a resize handle on its right edge: pointer motion
previews a clamped width while the main pane reflows, only pointer release
persists it in the sidebar renderer preference storage, and the handle is an
ARIA vertical separator with arrow, Home, and End steps where Escape or
cancellation restores the pointer-down width.

## Consequences

- Users pick a comfortable width without touching native window bounds, and the
  renderer stays the sole owner so no IPC contract is added.
- Collapsing preserves the preferred width.

## Alternatives

- A second resize channel from the native window: rejected, the sidebar is an
  in-flow renderer column that should only reflow the main pane.
