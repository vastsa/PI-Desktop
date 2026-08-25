# ADR 0078: Cross-platform tray-resident minimize

- Status: Accepted for implementation (amended by ADR 0117 and ADR 0123)
- Date: 2026-08-12
- Deciders: PI-Desktop core
- Related: D216, D252, D256, E2E-124, ADR 0117, ADR 0123

## Context

PI-Desktop already has custom window controls on Windows/Linux and native
traffic-light controls on macOS. Their minimize actions currently use native
window minimization, which makes the app disappear into different OS window
surfaces and does not provide a consistent way to keep background work
resident. The Electron Main process already owns window lifecycle and shutdown,
so a tray integration belongs there rather than in the renderer bridge.

## Decision

1. Electron Main creates one tray icon on every supported desktop platform.
   Packaged builds carry the existing product PNG as an extra resource for
   Windows/Linux. macOS carries a separate transparent monochrome template
   asset derived from the PI mark; the light application tile is not part of
   the menu bar silhouette.
2. Main intercepts the `minimize` event for the main window and hides it to the
   tray only for macOS traffic-light minimization. On Windows/Linux, native
   minimize transitions — including the renderer and native-menu actions —
   complete as ordinary OS minimization so the taskbar entry remains available.
   Hiding does not close the window or dispose either backend.
3. Tray click and double-click, the Show menu item, and macOS app activation
   restore and focus the existing window. If the window was closed, they create
   a new one through the existing window factory.
4. The tray menu contains localized Show PI-Desktop and Quit PI-Desktop items.
   Quit calls `app.quit()` and therefore follows the existing `before-quit`
   shutdown sequence. Closing the main window remains an explicit quit action.

## Consequences

- macOS keeps its tray-resident minimize behavior, while Windows/Linux use the
  normal taskbar minimize/restore affordance for explicit minimize actions.
  Close-to-tray remains available through the user-configurable close behavior.
- The renderer needs no new privileged IPC surface.
- A tray icon is a required packaged resource; a missing icon is logged and
  the app remains usable rather than crashing during boot.
- Window bounds persistence remains unchanged because a hidden window retains
  its normal bounds and is not treated as a new window state.
