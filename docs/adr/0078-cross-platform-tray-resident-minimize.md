# ADR 0078: Cross-platform tray-resident minimize

- Status: Accepted for implementation (amended by ADR 0117, ADR 0123, and ADR tray-session-shortcuts)
- Date: 2026-08-12
- Related: D216, D252, D256, ADR 0117, ADR 0123

## Context

Minimize used native window minimization on every platform, so the app disappeared
into different window surfaces with no consistent way to stay resident for
background work. Electron Main already owns window lifecycle and shutdown.

## Decision

Electron Main creates one tray icon per supported platform, using the product PNG on
Windows/Linux and a transparent monochrome template asset on macOS. Only macOS
traffic-light minimize hides the window to the tray; Windows/Linux minimize stays
ordinary OS minimization so the taskbar entry remains, and hiding never closes the
window or disposes a backend. Tray click and double-click, the Show item, and macOS
app activation restore and focus the existing window or create one through the
existing factory, and Quit goes through `app.quit()` and `before-quit`.

[ADR tray-session-shortcuts](tray-session-shortcuts.md) extends the restore and
menu clauses with bounded session groups and opens the macOS menu on single-click.

## Consequences

- macOS keeps tray-resident minimize while Windows/Linux keep taskbar
  minimize/restore; close-to-tray remains a configurable close behavior.
- No new privileged IPC surface is added, and a missing tray asset is logged rather
  than fatal.
- Window bounds persistence is unaffected because a hidden window keeps its bounds.

## Alternatives

- Leave minimize entirely native — rejected: background work then has no resident
  surface and macOS loses its traffic-light behavior.
- Hide to tray on every platform — rejected: Windows/Linux users lose the taskbar
  affordance.
