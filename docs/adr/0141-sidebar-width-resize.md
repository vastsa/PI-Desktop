# ADR 0141: Make Expanded Sidebar Width User-Resizable

- Status: Accepted (amended by [ADR 0290](0290-resizable-sidebar-collapse-threshold.md))
- Date: 2026-09-01

## Context

The sidebar's fixed expanded width makes long project names and session titles
hard to inspect, while a permanently wider sidebar wastes space for compact
workspaces. The shell already owns sidebar layout and collapse state, so width
preference state belongs at the same renderer boundary.

## Decision

The expanded sidebar exposes a resize handle on its right edge. Pointer motion
previews a width anchored to the pointer-down position and the main pane reflows
continuously.

The handle is an ARIA vertical separator. It supports ArrowLeft/ArrowRight with
16px steps, Home, and End.

## Consequences

- Users can choose a comfortable sidebar width without changing native window
  bounds or work-panel reservation behavior.
- The renderer remains the sole owner of sidebar width, avoiding a new IPC
  contract and keeping native window edge resize independent.
- A small edge hit area and visible focus/hover rule add a discoverable control
  without changing the dense sidebar row layout.

## Alternatives considered

- Fixed width: rejected because it prevents users from accommodating long
  project/session labels or reclaiming unused sidebar space.
- Native window reservation or a second resize channel: rejected because the
  sidebar is an in-flow renderer column and its width should only reflow the
  main pane.
