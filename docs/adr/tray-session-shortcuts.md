# ADR tray-session-shortcuts: Bounded session navigation in the native tray

- Status: Accepted
- Date: 2026-09-13
- Related: Issue #293, ADR 0078, ADR 0016, E2E-TRAY-bounded-session-navigation

## Context

The resident tray exposes only Open and Quit. Session pins and archives are
renderer-owned presentation metadata; Host owns session records and the durable
notification inbox. Background turns continue after the main window is hidden
or closed, so a renderer-only menu snapshot would become stale.

## Decision

1. Extend the existing native menu with Running, Unread, and Pinned groups in
   that order. Assign each eligible session to its highest-priority group
   before allocating rows: every non-empty group keeps up to three rows, then
   the share smaller groups leave unused goes to the groups that still
   overflow, in the same priority order, up to nine rows in total. A single
   busy group can therefore fill the whole menu when the others are empty,
   while no group is ever crowded out below its own share. Hide empty groups.
   Follow the existing session sort preference; unread results use newest-first
   inbox order and the same latest-result/read rule as sidebar outcome badges.
2. Renderer mirrors its session pin/archive/order metadata, archived project
   paths, and effective session sort through the main-window-only
   `tray/setSessionPreferences` IPC. Main validates it and retains only an
   ephemeral copy; localStorage remains the owner of organization preferences.
   No groups are shown until the first preference synchronization.
3. A Main-owned tray service reads `session.list` and `notification.list`
   (the existing 200-record inbox), consumes root agent lifecycle/status
   events, and refreshes after session/inbox mutations. It coalesces pending
   reads, rejects obsolete host generations, and clears shortcuts on a failed
   refresh. Windows/Linux hover/right-click retries a failed read. macOS does
   not subscribe to mouse-enter, which would replace the native status item.
   It continues to refresh with no renderer attached; deleting a
   session or archiving it or its project removes the shortcut.
4. A session click restores/focuses the main window and sends
   `tray/event/sessionActivated { sessionId }` (`null` means View more) only after the renderer finishes
   bootstrap and acknowledges menu readiness. Recheck existence and archive
   state after asynchronous waits. Renderer uses normal `selectSession`,
   including project alignment, navigation ownership, and read acknowledgement.
5. Opening the macOS tray menu does not restore the window or mark results
   read. Single-click opens the attached menu; double-click and Open retain
   window restore behavior. Each overflowing group has View more, which
   restores the main window and expands the existing session sidebar. Titles are one
   line and capped at 32 display columns including an ellipsis, counting an East
   Asian wide or emoji code point as two; labels use the active shipped locale.
   Quit retains confirmation and shutdown.

## Consequences

- Two additive allowlisted desktop IPC channels; the preferences setter is
  excluded from local MCP control and rejected for non-main-window senders.
- No database migration, host protocol version change, persisted preference
  format change, Plugin SDK change, new timers, or renderer persistence owner.
- Tray reuses existing organization sorting and latest-result helpers without
  changing their renderer behavior. Main retains its 1,500-line budget.
- Native menu rendering and cross-platform activation require the documented
  E2E scenario; unit/build results alone do not prove OS menu behavior.
