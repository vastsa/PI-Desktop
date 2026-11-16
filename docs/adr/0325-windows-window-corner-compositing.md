# ADR 0325: Use native DWM corners for the Windows 11 main window

- Status: Proposed; implementation candidate awaits Windows native qualification
- Date: 2026-10-10
- Related: D635, D637, E2E-167, ADR 0248, ADR 0317

## Context

The Windows main window relies on a transparent outer window,
`contentView.setBorderRadius()` for the visible clip, and `setShape()` for the
native hit region, but Windows 11's DWM corner API may ignore its rounding hint
for windows that use per-pixel alpha or a window region, so that path cannot
guarantee the system-rendered curve.

## Decision

For the Windows main window only, builds from 22000 onward create an opaque,
frameless window and request `DWMWA_WINDOW_CORNER_PREFERENCE` through the
existing Electron Main to Host Core boundary, without `setShape()` or
`contentView.setBorderRadius()`. Host Core accepts only the HWND whose owning
PID matches the Electron PID injected at startup, so no plugin, renderer, or
standalone-window API is added. Radius `0` and maximized or fullscreen states map
to `DWMWCP_DONOTROUND` and every positive authorized radius maps to
`DWMWCP_ROUND`, with Windows 11 choosing the visible radius while the public
range and default stay unchanged. A contributed `#rrggbbaa` background is
flattened over the resolved theme background so alpha never creates per-pixel
window transparency, and the existing `window/setBackgroundColor` contract,
theme fallback, geometry persistence, and native frameless edge resize are kept.
Windows builds before 22000, macOS, Linux, plugin standalone windows, and
floating components are unchanged.

## Consequences

- Windows 11 uses the system's antialiased corners and native corner hit
  behavior instead of transparent pixels or an integer region.
- Positive radii keep their meaning as "rounded" while Windows picks the value,
  and older Windows builds keep their exact DIP clip.
- DWM may decline to round based on window style or environment, so native
  qualification must confirm the result before any release claim.

## Qualification gate

The decision stays proposed until a Windows desktop running Electron 43.6.0
proves the rounded opaque window, theme and alpha flattening, child-view
containment, state transitions, native resize and bounds persistence, and the
unchanged pre-22000 path.
