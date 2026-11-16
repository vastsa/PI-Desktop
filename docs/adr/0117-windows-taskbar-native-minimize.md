# ADR 0117: Preserve the Windows taskbar entry for native minimize

- Status: Accepted (amended by ADR 0123)
- Date: 2026-08-24
- Related: D216, D252, D256, ADR 0078, ADR 0123

## Context

The tray-resident minimize decision in D216 hides the main window from the OS
window list. On Windows, clicking the taskbar button of a focused window is a
native minimize toggle that Electron reports through the main window's
`minimize` event, and the current handler answers it with `window.hide()`, which
removes the taskbar entry and leaves the tray icon as the only restore path.

## Decision

On Windows the native `minimize` event is not converted to `window.hide()`: the
OS completes the minimize and the window keeps its taskbar entry. The
renderer-drawn Windows minimize button and the Windows native-menu minimize
action use that same native transition, Linux uses it for both of its minimize
actions, and the macOS native minimize event stays tray-resident. The existing
restore path still restores and focuses the same window, so no new IPC,
storage, or host protocol contract is needed.

## Consequences

- Windows has one native taskbar minimize model for the taskbar toggle and the
  in-app minimize action.
- Windows and Linux windows minimized to the taskbar stay reachable there, while
  close-to-tray windows stay reachable from the tray icon.
- Background work and window bounds persistence are unchanged.
