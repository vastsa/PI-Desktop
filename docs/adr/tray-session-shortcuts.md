# ADR tray-session-shortcuts: Bounded session navigation in the native tray

- Status: Accepted
- Date: 2026-09-13
- Related: Issue #293, ADR 0078, ADR 0016, E2E-TRAY-bounded-session-navigation

## Context

The resident tray exposes only Open and Quit. Session pins and archives are
renderer-owned presentation metadata; Host owns session records and the durable
notification inbox.

## Decision

1. Extend the existing native menu with Running, Unread, and Pinned groups in
   that order.
2. Renderer mirrors its session pin/archive/order metadata, archived project
   paths, and effective session sort through the main-window-only
   `tray/setSessionPreferences` IPC.
3. A Main-owned tray service reads `session.list` and `notification.list` (the
   existing 200-record inbox), consumes root agent lifecycle/status events, and
   refreshes after session/inbox mutations.
4. A session click restores/focuses the main window and sends
   `tray/event/sessionActivated { sessionId }` (`null` means View more) only
   after the renderer finishes bootstrap and acknowledges menu readiness.
5. Opening the macOS tray menu does not restore the window or mark results read.

## Consequences

- Two additive allowlisted desktop IPC channels; the preferences setter is
  excluded from local MCP control and rejected for non-main-window senders.
- No database migration, host protocol version change, persisted preference
  format change, Plugin SDK change, new timers, or renderer persistence owner.
- Tray reuses existing organization sorting and latest-result helpers without
  changing their renderer behavior.
- Native menu rendering and cross-platform activation require the documented E2E
  scenario; unit/build results alone do not prove OS menu behavior.
