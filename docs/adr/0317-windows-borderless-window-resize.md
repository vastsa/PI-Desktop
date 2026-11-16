# ADR 0317: Preserve Windows resizing without the native frameless rim

- Status: Accepted
- Date: 2026-09-29
- Related: D635, D637, ADR 0025, ADR 0248

## Context

Electron 43 paints a visible region on the left, bottom, and right of a
frameless resizable Windows window with the default thick frame, and the renderer
cannot paint into it. Disabling `WS_THICKFRAME` removes the rim and the window
animations, and although the public option description warns about losing edge
dragging, the pinned Electron 43.6 frameless hit test still resizes on native
edges and corners.

## Decision

Disable the Windows thick frame on the main window only, keeping Electron's
native frameless edge and corner hit testing plus the existing minimum-size
contract, with no renderer resize handles or geometry IPC; macOS and Linux keep
native edge resizing and the work-panel width stays a separate renderer-owned
interaction. Because `thickFrame: false` changes fullscreen display bounds
without setting the value `isFullScreen()` returns, main tracks that fallback so
fullscreen toggles, renderer events, and persisted normal bounds stay correct.

On Windows builds before 22000 the existing 12 DIP `--radius-md` `contentView`
clip and native `setShape()` hit region stay, and a plugin with
`ui.window.appearance` may declare an integer `cornerRadius` from 0 to 24 DIP
that the selected theme supplies through the window-appearance IPC, with main
validating the value and the caller. On build 22000 and later ADR 0325 replaces
both with the system DWM corner preference, which keeps zero square, treats any
positive radius as system-rounded, and requires an opaque top-level window.

## Consequences

- The Windows main window has no painted left, bottom, or right native rim, and
  edge resizing and minimum size stay owned by Electron on every platform.
- Native shadow, minimize/maximize animation, and snap may differ with
  `WS_THICKFRAME` removed, so they need native qualification before landing and
  no shadow setting is added.
- The Plugin SDK gains one optional permission-gated appearance property; old
  manifests stay valid and no host RPC, schema, or persisted format changes.

## Alternatives

- Keep the thick frame: it leaves the visible rim.
- Make the window transparent: it changes the opaque background and theme
  contract without removing the need to qualify resizing.
