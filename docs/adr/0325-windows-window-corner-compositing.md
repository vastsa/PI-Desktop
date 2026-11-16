# ADR 0325: Use native DWM corners for the Windows 11 main window

- Status: Proposed; implementation candidate awaits Windows native qualification
- Date: 2026-10-10
- Deciders: PI-Desktop maintainers
- Related: D635, D637, E2E-167, ADR 0248, ADR 0317

## Context

The Windows main window currently uses a transparent outer window,
`contentView.setBorderRadius()` for the visible clip, and `setShape()` for the
native hit region. This keeps child views inside one clip, but depends on
Electron transparency and a window region.

## Decision

For the Windows main window only:

1. On Windows build 22000 and later, create an opaque, frameless window and
   request the native DWM corner preference through the existing Electron Main
   to Host Core process boundary.
2. Host Core accepts only the HWND whose owning PID matches the Electron PID
   injected by Electron Main when it starts Host Core.
3. Map radius `0` and maximized/fullscreen states to `DWMWCP_DONOTROUND`.
4. Keep the existing transparent content clip and native shape path on Windows
   builds before 22000.
5. On the Windows 11 path, keep the top-level surface opaque.
6. Keep the existing `window/setBackgroundColor` request and response,
   validation, theme fallback, geometry persistence, and native frameless edge
   resize behavior.

## Consequences

- Windows 11 uses the system's antialiased corner rendering and native corner
  hit behavior.
- Positive theme radii keep their range and meaning as “rounded,” but Windows 11
  chooses the radius.
- DWM may decline to round a window based on its style or environment, and
  Windows may keep snapped or virtualized windows square.
- The Windows 11 background stays opaque; alpha colors are composited against
  the built-in palette.
