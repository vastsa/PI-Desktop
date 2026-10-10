# ADR 0325: Smooth Windows main-window corner compositing

- Status: Proposed; implementation candidate awaits Windows native qualification
- Date: 2026-10-10
- Deciders: PI-Desktop maintainers
- Related: D635, D637, E2E-167, ADR 0248, ADR 0317

## Context

The Windows main window currently uses an opaque `BrowserWindow` background
and a row-based `setShape()` region. The native region controls drawing and
pointer hit testing together, so its integer rectangles produce a hard edge.
The opaque window background can also remain visible behind rounded content
and expose a second color at the lower corners. Renderer CSS alone cannot clip
native `WebContentsView` children such as the browser and plugin panel.

Electron 43.6.0 exposes `View.setBorderRadius()` on the shared `contentView`.
It clips the view tree with a smooth path, but its cutout still captures clicks.
The existing native region therefore remains necessary for click-through and
must be broad enough not to cut off antialiased pixels.

## Decision

Propose the following implementation for the Windows main window, subject to
the qualification gate below:

For the Windows main window only:

1. Create the `BrowserWindow` with a transparent outer surface.
2. Apply the built-in or validated plugin theme background to the shared
   `contentView`, then apply the selected radius with
   `contentView.setBorderRadius()`. Child `WebContentsView` content remains
   inside that common clip.
3. Keep `BrowserWindow.setShape()` as the native hit region. Generate it from
   the actual content-view dimensions and refresh it after resize, monitor/DPI,
   maximize, fullscreen, show, and restore transitions. The hit region includes
   antialias edge coverage without becoming the visible curve.
4. Preserve the 12 DIP default, integer 0–24 DIP authorized theme range,
   existing IPC validation and response, and square corners while maximized or
   fullscreen. A return to a normal window restores the selected radius.
5. Convert plugin `#RRGGBB` / `#RRGGBBAA` values to explicit `rgba(...)` before
   passing them to Electron. Keep Linux's native window background behavior
   and macOS vibrancy/background behavior unchanged.

No renderer CSS radius, resize IPC, database change, plugin API change, shadow
setting, outer margin, or companion window is introduced.

## Qualification gate

This decision remains proposed until a dedicated Windows desktop proves all
of the following with Electron 43.6.0:

- Composited screenshots show a smooth curve at all four corners and only
  expected blending between content and the known desktop background.
- Transparent corners and pixels outside the rounded silhouette pass hit
  testing through to the background window.
- Browser/plugin child views stay clipped by the common parent.
- Native edge and corner resizing, the work-area-capped 800×560 minimum,
  window-state restoration, and settled bounds persistence still work.
- The result holds at 100%, 125%, 150%, 175%, and 200% scaling. Different-DPI
  monitor movement is also checked when a suitable desktop is available.

`test:e2e:window-controls` samples native hit ownership. The isolated
`test:e2e:window-surface` fixture samples the composed screen pixels over
controlled light and dark backgrounds at radii 0, 12, and 24 DIP. If those
checks show that transparent click-through and smooth rendering cannot coexist,
do not accept the implementation; revise the approach and record the measured
failure first.

## Consequences

- The theme background is painted inside the same rounded native view that
  clips the renderer and its child views, removing a separate opaque corner
  plate.
- `setShape()` remains part of native interaction, but no longer defines the
  visible curve.
- Windows transparency and resize behavior require the native qualification
  above. This candidate is not release-qualified until that evidence exists.
- macOS/Linux windows, plugin standalone windows, floating widgets, persisted
  geometry, and the public window IPC remain unchanged.
