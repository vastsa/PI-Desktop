# ADR: Restore Windows snapping without Electron frame insets

- Status: Accepted
- Date: 2026-11-13
- Related: ADR 0317, ADR 0325, issue #2330

## Context

The pinned Electron drops `WS_THICKFRAME` and `WS_CAPTION` for a `thickFrame:
false` window, excluding it from native keyboard and titlebar-drag snapping, while
enabling Electron's thick frame would restore client-area insets and regress the
borderless surface fixed by ADR 0317.

## Decision

Keep `frame: false` and `thickFrame: false` and let a private Main-to-Host RPC,
`window.enableNativeSnap`, restore only the HWND's `WS_THICKFRAME | WS_CAPTION`
bits while preserving other styles and bounds, so Electron keeps its inset-free
client layout; `WS_CAPTION` also avoids the maximized DWM overshoot seen with
`WS_THICKFRAME` alone, and Windows 11's `DWMWA_BORDER_COLOR` is set to
`DWMWA_COLOR_NONE` so DWM cannot paint an outline over client edges, with Windows
10's unsupported-attribute `E_INVALIDARG` handled explicitly and other native
failures left as errors.

The RPC accepts a decimal HWND and owner PID, never an arbitrary style mask: Host
checks the PID against Main's injected PID and verifies the live HWND owner before
mutating, sharing that validation with the corner RPC, and exposes no raw handle or
new channel to renderer, preload, plugins, or remote clients. Main awaits initial
application before showing the window and reapplies after show, focus and blur,
restore, maximize and unmaximize, leaving fullscreen, activation changes, and
returning from fullscreen, cancelling queued work on close and logging errors
without blocking startup. Existing minimum sizes, persistence, resizing, corners,
fullscreen interlocks, and maximize/work-area correction are unchanged.

## Consequences

- Keyboard and titlebar-drag snapping work on the borderless window, with the
  client and the DWM-visible maximized frame matching the work area.
- Renderer, plugin, and remote surfaces gain no window-handle capability.
- The custom maximize button still needs separate `HTMAXBUTTON` integration for
  hover Snap Layouts, and native layout and pixels must be requalified on Electron
  upgrades. The isolated replay is described in
  [independent replay](../project/windows-native-snap-replay.md).

## Alternatives

- Enable Electron's thick frame: rejected because its client-area insets regress
  the borderless surface.
- Intercept keys or implement snapping in the renderer: rejected because native
  window behavior stays outside the renderer.
