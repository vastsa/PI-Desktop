# ADR 0117: Preserve the Windows taskbar entry for native minimize

- Status: Accepted (amended by ADR 0123)
- Date: 2026-08-24
- Deciders: PI-Desktop core
- Related: D216, D252, D256, E2E-124, ADR 0078, ADR 0123

## Context

The tray-resident minimize decision in D216 hides the main window from the
operating system's window list. On Windows, clicking the taskbar button of the
focused window is a native minimize/restore toggle.

## Decision

1. On Windows, the main window's native `minimize` event is not converted to
   `window.hide()`.
2. The renderer-drawn Windows minimize button and the Windows native-menu
   minimize action use the same native minimize transition.
3. The existing restore path continues to restore and focus the same window.

## Consequences

- Windows has one native taskbar minimize model for both the OS taskbar toggle
  and the explicit in-app minimize action.
- Windows/Linux taskbar-minimized windows remain reachable from the taskbar;
  close-to-tray windows remain reachable from the resident tray icon.
- Background work and window bounds persistence are unchanged.
