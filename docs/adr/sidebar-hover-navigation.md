# Sidebar hover navigation

- Status: Accepted for local implementation; upstream proposal in #2144
- Date: 2026-11-06

## Context

Collapsed navigation currently requires docking the sidebar, which reallocates
conversation and work-panel space. The owner requested selectable navigation
on hover without first opening the dock.

## Decision

Reuse the existing Sidebar as a transient floating surface. A 180ms hover on
the collapsed titlebar control opens it; another 180ms bridges pointer travel
to the surface. There is no window-edge trigger. Floating navigation allocates
no flex width, uses the committed sidebar width and disables resizing.

Existing click and shortcut behavior docks the sidebar through the existing
width-budget and work-panel lending logic. The floating header action uses
the existing Expand sidebar label. ArrowDown on the focused titlebar control
opens the surface and focuses its first action. Escape restores trigger focus.

Selection of a different session or route, outside press, pointer departure,
Escape and window blur close the preview. Focus within the surface and
sidebar-owned portaled interactions keep it available. Child menus and dialogs
retain their dismissal handling; later outside movement retires an otherwise
stranded preview. Native views yield through the existing blocking-overlay
owner while floating navigation is mounted.

## Alternatives

- Dock on hover: rejected because merely checking history would move content.
- Read-only list: rejected because it duplicates navigation and cannot support
  project groups or existing conversation actions.
- Window-edge trigger: omitted because it competes with file/plugin content.
- Persistent preference: omitted because no separate configuration is needed.

## Consequences

The renderer owns only transient presentation and timers. Session/project
selection, menu actions, credentials, Host storage, layout-collapse ownership
and committed width remain with their existing owners. Touch uses click;
there is no animated preview transition, so reduced-motion users see the same
immediate surface. No migration, new dependency or IPC contract is required.

Controlled interaction tests cover the preview state and event handlers.
Physical pointer travel, native view restoration, light/dark appearance and
Windows/Linux hit testing still require native E2E qualification.
