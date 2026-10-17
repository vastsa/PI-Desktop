# ADR 0325: Use native DWM corners for the Windows 11 main window

- Status: Proposed; implementation candidate awaits Windows native qualification
- Date: 2026-10-10
- Deciders: PI-Desktop maintainers
- Related: D635, D637, E2E-167, ADR 0248, ADR 0317

## Context

The Windows main window currently uses a transparent outer window,
`contentView.setBorderRadius()` for the visible clip, and `setShape()` for the
native hit region. This keeps child views inside one clip, but depends on
Electron transparency and a window region. Windows 11's DWM corner API may
ignore its rounding hint for windows that use per-pixel alpha or a window
region, so that path cannot guarantee the system-rendered curve.

The Windows 11 API provides `DWMWA_WINDOW_CORNER_PREFERENCE`. Its `ROUND`
preference is a system hint, not a promise of a specific radius or that every
window style will be rounded. Windows 11 deliberately keeps maximized and
snapped windows square. See Microsoft's guidance on
[rounded corners](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-rounded-corners)
and the [`DWM_WINDOW_CORNER_PREFERENCE` values](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_window_corner_preference).

## Decision

For the Windows main window only:

1. On Windows build 22000 and later, create an opaque, frameless window and
   request the native DWM corner preference through the existing Electron Main
   to Host Core process boundary. Do not call `setShape()` or
   `contentView.setBorderRadius()` on this path.
2. Host Core accepts only the HWND whose owning PID matches the Electron PID
   injected by Electron Main when it starts Host Core. No plugin, renderer, or
   standalone-window API is added.
3. Map radius `0` and maximized/fullscreen states to `DWMWCP_DONOTROUND`. Map
   every positive authorized radius to `DWMWCP_ROUND`. Windows 11 owns the
   visible system radius; values 1 through 24 DIP do not select distinct exact
   radii. The public plugin range and default remain unchanged.
4. Keep the existing transparent content clip and native shape path on Windows
   builds before 22000. Keep macOS, Linux, plugin standalone windows, and
   floating components unchanged.
5. On the Windows 11 path, keep the top-level surface opaque. A contributed
   `#rrggbbaa` background is flattened over the resolved built-in theme
   background before it is applied, so alpha does not create per-pixel window
   transparency.
6. Keep the existing `window/setBackgroundColor` request and response,
   validation, theme fallback, geometry persistence, and native frameless edge
   resize behavior. No renderer corner state, resize emulation, database field,
   plugin permission, setting, or public API is added.

## Qualification gate

This decision remains proposed until a dedicated Windows desktop running
Electron 43.6.0 proves all of the following:

- Windows 11 displays a DWM-rounded opaque main window with radius 0 square and
  positive radii rounded; tests do not assume 12 and 24 DIP produce different
  system radii.
- Theme changes update the opaque native background, including alpha
  flattening and fallback after a theme is disabled or removed.
- Browser and plugin child views remain within the top-level visible outline.
- Maximize, fullscreen, restore, minimize, show, and DPI changes restore the
  correct system preference.
- Native edge/corner resizing, the work-area-capped 800×560 minimum, settled
  bounds persistence, and the existing window placement behavior remain intact.
- The native corner hit behavior is recorded on Windows 11; this path no longer
  promises `setShape()` click-through outside the rounded silhouette.
- Windows builds before 22000 retain the existing rounded shape and native
  resize behavior. macOS and Linux regressions are also checked.

The `DWM_WINDOW_CORNER_PREFERENCE` API is explicitly best-effort. If the
Windows 11 build used for qualification does not render the requested rounded
window with this Electron style, do not call the candidate complete; record the
observed behavior and revise the approach.

## Consequences

- Windows 11 uses the system's antialiased corner rendering and native corner
  hit behavior. It no longer uses transparent pixels or an integer `setShape()`
  region for the visible silhouette.
- Positive theme radii keep their range and meaning as “rounded,” but Windows
  11 chooses the radius. Windows builds before 22000 retain the prior exact DIP
  clip behavior.
- DWM may decline to round a window based on its style or environment, and
  Windows may keep snapped or virtualized windows square. Windows native
  qualification is required before release claims.
- The Windows 11 background stays opaque; alpha colors are composited against
  the built-in palette. Other platforms keep their existing background and
  vibrancy behavior.
