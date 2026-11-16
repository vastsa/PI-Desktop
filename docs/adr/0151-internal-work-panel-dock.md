# ADR 0151: Keep the work panel inside the fixed application window

- Status: Accepted; supersedes ADR 0122 and the work-panel boundary clauses of
  ADR 0146, restores the internal-dock direction from ADR 0033, and is amended by
  ADR 0238 (three-column width budget) and ADR 0226 (chat reservation)
- Date: 2026-09-03
- Related: E2E-056, E2E-167

## Context

The work panel is already an in-flow flex sibling, but ADR 0122 made the renderer
request a matching native reservation, so Electron grew and later shrank the whole
window whenever the panel opened or collapsed. The panel should behave like the
left sidebar, taking its width from the existing client area while MainChat
reflows beside it, and the native Browser `WebContentsView` is positioned from the
renderer-measured panel rectangle instead of a larger window.

## Decision

1. The work panel stays a right-side in-flow flex column whose open and collapse
   animate its flex allocation without changing native BrowserWindow bounds, with
   its committed width bounded by the live three-column budget.
2. The renderer keeps the `window/setWorkPanelReservation` seam at zero; Main
   normalizes every valid request to `{ requested: 0, reserved: 0 }` and never
   applies panel width or x-offset geometry.
3. The panel's inner left-edge separator is renderer-owned: pointer preview is
   frame-coalesced, release commits the preferred width, and Escape, cancellation,
   or lost capture restores the press-time width.
4. Native window edges and corners resize the application window, never the panel;
   the preferred panel width stays renderer-local and persists independently of
   native bounds.
5. The Browser view follows the renderer-measured panel rectangle and is detached
   before the exit animation, because a native view cannot follow renderer CSS
   animation.

## Consequences

- Opening and collapsing no longer move the window edge or change application
  bounds; the panel occupies internal space like the left sidebar.
- The renderer keeps a 515px chat reservation for the composer even when the client
  area cannot show every dock at its preferred width.
- Native reservation and chat-width IPC shapes remain as unused compatibility
  seams, and bounds persistence no longer removes temporary panel geometry.

## Alternatives

- Keep the ADR 0122 native reservation: expanding the whole application window is
  exactly the outward behavior this change removes.
- Overlay the panel without flex allocation: it would cover chat content and break
  the measured Browser surface and focus order.
