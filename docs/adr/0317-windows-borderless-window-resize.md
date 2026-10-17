# ADR 0317: Preserve Windows resizing without the native frameless rim

- Status: Accepted
- Date: 2026-09-29
- Deciders: PI-Desktop maintainers
- Related: D635, D637, E2E-167, ADR 0025, ADR 0248

## Context

Electron 43 paints a visible region on the left, bottom, and right of a
frameless, resizable Windows window with the default thick frame. The renderer
cannot paint into that native area. Disabling `WS_THICKFRAME` removes the rim
and window animations. Although Electron's public option description warns of
losing edge dragging, the pinned Electron 43.6 frameless hit test still handles
native edge and corner resizing. The application requires its existing minimum
size, settled bounds persistence, and separate work-panel resize ownership to
remain intact.

## Decision

Disable the Windows thick frame on the main window only. Retain Electron's
native frameless edge/corner hit testing and the current minimum-size contract;
the renderer adds no resize handles or geometry IPC. Qualify this against the
pinned Electron version with real native edge/corner drags and minimum-size
checks, since the public option description is more restrictive than the
observed implementation.

macOS and Linux keep native edge resizing. Work-panel width remains a separate
renderer-owned interaction; the window resize changes only application bounds.
Electron's `thickFrame: false` fullscreen path changes display bounds without
setting the value returned by `isFullScreen()`. Main tracks this fallback so
fullscreen toggles, renderer events, and persisted normal bounds remain correct.

On Windows builds before 22000, keep the existing 12 DIP `--radius-md`
`contentView` clip and native `setShape()` hit region. A plugin with
`ui.window.appearance` may declare an integer `cornerRadius` from 0 to 24 DIP
alongside its background colours; the selected theme supplies it through the
existing window-appearance IPC, and removing the theme restores 12 DIP. Main
validates the value and the calling renderer before changing the shape.

On Windows build 22000 and later, ADR 0325 replaces both the visible `setShape()`
curve and the shared content-view clip with the system DWM corner preference.
Zero remains square and any positive radius requests a system-rounded window;
DWM does not promise distinct 12 or 24 DIP radii. This path requires an opaque
top-level window and leaves native corner hit behavior to Windows.

### Proposed rendering amendment

ADR 0325 proposes the DWM path for Windows 11 and later while keeping the
existing shape path for older Windows builds. It keeps this ADR's native
resize and minimum-size contracts. The candidate remains unqualified until
Windows pixel, corner-hit, DPI, and resize checks in E2E-167 pass; source-level
or mocked checks alone do not qualify it.

## Alternatives

- Keep the thick frame: leaves the visible rim.
- Make the window transparent: changes the opaque background and theme
  contract without removing the need to qualify native resizing.
- Use only renderer CSS rounding: leaves the opaque native background visible
  in the corners and cannot change the window's native hit region.
- Pin an older Electron: trades away newer security and runtime fixes for a
  historical rendering behavior.
- Wait for an upstream Electron fix: does not resolve the current UI defect.

## Consequences

- The Windows main window has no painted left, bottom, or right native rim.
- Native edge resizing and minimum size remain owned by Electron on every
  platform; there is no parallel renderer/Main resize path.
- Windows native shadow, minimize/maximize animation, and snap behavior may
  differ with `WS_THICKFRAME` removed. They require native qualification before
  landing; the application must not claim parity without that check.
- The native shadow cannot be made theme-configurable through Electron while
  this thick-frame-free window retains its current bounds. An external CSS
  shadow would need transparent window margin or a companion surface, changing
  window geometry and lifecycle; this decision does not add a shadow setting.
- Windows builds before 22000 retain the non-antialiased pixel-row `setShape()`
  curve and its native hit region. Windows 11 and later use DWM's best-effort
  system curve and native hit behavior; that API does not promise click-through
  in clipped corner pixels. Both paths need the platform checks in E2E-167.
- The Plugin SDK gains one optional, permission-gated appearance property. Old
  manifests remain valid. No host RPC, database schema, or persisted format
  changes.
