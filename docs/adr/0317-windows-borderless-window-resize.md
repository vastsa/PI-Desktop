# ADR 0317: Preserve Windows resizing without the native frameless rim

- Status: Accepted
- Date: 2026-09-29
- Deciders: PI-Desktop maintainers
- Related: D635, D637, E2E-167, ADR 0025, ADR 0248

## Context

Electron 43 paints a visible region on the left, bottom, and right of a
frameless, resizable Windows window with the default thick frame. The renderer
cannot paint into that native area.

## Decision

Disable the Windows thick frame on the main window only. Retain Electron's
native frameless edge/corner hit testing and the current minimum-size contract;
the renderer adds no resize handles or geometry IPC.

macOS and Linux keep native edge resizing. Work-panel width remains a separate
renderer-owned interaction; the window resize changes only application bounds.

### Proposed rendering amendment

ADR 0325 proposes the DWM path for Windows 11 and later while keeping the
existing shape path for older Windows builds. It keeps this ADR's native resize
and minimum-size contracts.

## Alternatives

- Keep the thick frame: leaves the visible rim.
- Make the window transparent: changes the opaque background and theme contract
  without removing the need to qualify native resizing.
- Use only renderer CSS rounding: leaves the opaque native background visible in
  the corners and cannot change the window's native hit region.
- Pin an older Electron: trades away newer security and runtime fixes for a
  historical rendering behavior.

## Consequences

- The Windows main window has no painted left, bottom, or right native rim.
- Native edge resizing and minimum size remain owned by Electron on every
  platform; there is no parallel renderer/Main resize path.
- Windows native shadow, minimize/maximize animation, and snap behavior may
  differ with `WS_THICKFRAME` removed.
- The native shadow cannot be made theme-configurable through Electron while
  this thick-frame-free window retains its current bounds.
- Windows builds before 22000 retain the non-antialiased pixel-row `setShape()`
  curve and its native hit region.
