# ADR 0078: Cross-platform tray-resident minimize

- Status: Accepted for implementation (amended by ADR 0117, ADR 0123, and ADR tray-session-shortcuts)
- Date: 2026-08-12
- Deciders: PI-Desktop core
- Related: D216, D252, D256, E2E-124, ADR 0117, ADR 0123

## Context

PI-Desktop already has custom window controls on Windows/Linux and native
traffic-light controls on macOS. Their minimize actions currently use native
window minimization, which makes the app disappear into different OS window
surfaces and does not provide a consistent way to keep background work resident.

## Decision

1. Electron Main creates one tray icon on every supported desktop platform.
2. Main intercepts the `minimize` event for the main window and hides it to the
   tray only for macOS traffic-light minimization.
3. Tray click and double-click, the Show menu item, and macOS app activation
   restore and focus the existing window.
4. The tray menu contains localized Show PI-Desktop and Quit PI-Desktop items.

## Consequences

- macOS keeps its tray-resident minimize behavior, while Windows/Linux use the
  normal taskbar minimize/restore affordance for explicit minimize actions.
- The renderer needs no new privileged IPC surface.
- A tray icon is a required packaged resource; a missing icon is logged and the
  app remains usable rather than crashing during boot.
- Window bounds persistence remains unchanged because a hidden window retains
  its normal bounds and is not treated as a new window state.

## Session-menu amendment

[ADR tray-session-shortcuts](tray-session-shortcuts.md) extends clauses 3–4 with
bounded session groups and makes macOS single-click open the menu without
restoring the main window. Open, double-click, and Quit retain their lifecycle
behavior.
