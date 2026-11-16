# ADR 0123: Use native taskbar minimize for Windows/Linux window controls

- Status: Accepted
- Date: 2026-08-25
- Related: ADR 0078, ADR 0090, ADR 0117, D216, D230, D252, D256

## Context

The frameless Windows/Linux window draws its own controls, and minimize called
`window.hide()`, removing the window from the taskbar and behaving like
close-to-tray, which already has its own persisted `tray`/`quit` choice.

## Decision

The renderer `minimize` action and the native-menu minimize action call
Electron's `BrowserWindow.minimize()` on Windows and Linux, and the main-window
`minimize` event no longer converts that into `hide()`, so the taskbar entry
survives and the same window restores. macOS keeps its tray-resident minimize,
close behavior stays owned by ADR 0090, and the tray, close-behavior
persistence, IPC action allowlists, host protocol, and background-process
lifetime are unchanged.

## Consequences

- Minimize goes to the taskbar, maximize toggles, and close follows the
  remembered tray/quit choice.
- No second tray lifecycle and no new privileged bridge or protocol version.

## Alternatives considered

- Keep minimize as hide-to-tray: rejected; it makes minimize and close
  indistinguishable.
- Remove the resident tray: rejected; close-to-tray still needs a restore
  surface.
