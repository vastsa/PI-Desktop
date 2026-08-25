# ADR 0123: Use native taskbar minimize for Windows/Linux window controls

- Status: Accepted
- Date: 2026-08-25
- Deciders: PI-Desktop core
- Related: D216, D230, D252, D256, E2E-124, ADR 0078, ADR 0090, ADR 0117

## Context

Windows/Linux use a frameless window with renderer-drawn minimize, maximize,
and close controls. The minimize action was calling `window.hide()`, which
removed the window from the taskbar and made the action behave like a
close-to-tray operation. The close button already has an independent,
persisted `tray`/`quit` choice, so two different controls were unexpectedly
using the same hidden-window behavior.

## Decision

1. The Windows/Linux renderer window-control `minimize` action calls
   Electron's native `BrowserWindow.minimize()` transition. The Windows/Linux
   native-menu minimize action uses the same transition.
2. The main-window `minimize` event does not convert Windows/Linux native
   minimization into `hide()`. The operating system keeps the taskbar entry so
   the user can restore the same window normally.
3. macOS keeps its existing traffic-light tray-resident minimize behavior.
   Windows/Linux close behavior remains owned by ADR 0090: the close button
   hides to the tray for `tray` and exits for `quit`.
4. The resident tray, close-behavior persistence, IPC action allowlists, host
   protocol, and background-process lifetime do not change.

## Consequences

- The three Windows/Linux window buttons now match the expected desktop model:
  minimize goes to the taskbar, maximize toggles the window, and close follows
  the user's remembered tray/quit choice.
- The tray remains available for close-to-tray and for macOS's existing
  minimize behavior; no second tray lifecycle is introduced.
- No new privileged bridge or protocol version is required because the
  existing `minimize` action changes only its Main-owned Electron effect.

## Alternatives considered

- **Keep explicit minimize as hide-to-tray:** rejected because it makes the
  minimize and close controls indistinguishable when close-to-tray is selected
  and removes the standard taskbar restore path.
- **Remove the resident tray:** rejected because close-to-tray and macOS
  minimize still need a reliable restore surface.
