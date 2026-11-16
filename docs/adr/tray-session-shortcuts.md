# ADR tray-session-shortcuts: Bounded session navigation in the native tray

- Status: Accepted
- Date: 2026-09-13
- Related: Issue #293, ADR 0078, ADR 0016, E2E-TRAY-bounded-session-navigation

## Context

The resident tray exposed only Open and Quit. Session pins and archives are
renderer-owned presentation metadata while the Host owns session records and the
durable notification inbox, and background turns continue after the window is
hidden, so a renderer-only snapshot would go stale.

## Decision

1. The native menu gains Running, Unread, and Pinned groups in that order, each
   session assigned to its highest-priority group, with every non-empty group
   keeping a minimum share and leftover rows redistributed to groups that still
   overflow up to a fixed total. Empty groups are hidden, groups follow the
   session sort preference, and unread results use newest-first inbox order with
   the sidebar's latest-result and read rule.
2. The renderer mirrors pin/archive/order metadata, archived project paths, and
   the effective sort through the main-window-only `tray/setSessionPreferences`
   IPC, which Main validates and keeps only ephemerally while localStorage stays
   the owner of organization preferences.
3. A Main-owned tray service reads `session.list` and `notification.list`,
   consumes root agent lifecycle events, refreshes after session and inbox
   mutations, coalesces pending reads, rejects obsolete host generations, and
   clears shortcuts when a refresh fails, with no renderer attached.
4. A session click restores and focuses the window and sends
   `tray/event/sessionActivated { sessionId }` (`null` for View more) only after
   the renderer finishes bootstrap and acknowledges menu readiness, rechecking
   existence and archive state after waits.
5. Opening the macOS menu does not restore the window or mark results read, and
   each overflowing group offers View more, which restores the window and
   expands the sidebar.

## Consequences

- Two additive allowlisted desktop IPC channels, with the preference setter
  excluded from local MCP control and from non-main-window senders.
- No database migration, host protocol version change, or persisted format
  change.
- Native menu behavior is proven by the documented E2E scenario, not by unit or
  build results alone.
