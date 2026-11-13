# ADR: Restore Windows snapping without Electron frame insets

- Status: Accepted
- Date: 2026-11-13
- Related: issue #2330, ADR 0317, ADR 0325, E2E-167

## Context

Pinned Electron 43.6.0 removes `WS_THICKFRAME` and `WS_CAPTION` when the main
window uses `thickFrame: false`, excluding it from native keyboard and titlebar
drag snapping. Enabling Electron's thick frame restores its left/right/bottom
client-area insets and would regress the borderless surface fixed by ADR 0317.

## Decision

Keep `frame: false` and `thickFrame: false`. Private Main-to-Host RPC
`window.enableNativeSnap` restores only the HWND's `WS_THICKFRAME | WS_CAPTION`
bits, preserving other styles and bounds. Electron keeps its inset-free client
layout. `WS_CAPTION` also prevents the maximized DWM overshoot seen when only
`WS_THICKFRAME` is restored. Set Windows 11's `DWMWA_BORDER_COLOR` to
`DWMWA_COLOR_NONE` so DWM cannot paint an outline over the client edges.
Windows 10's unsupported-attribute `E_INVALIDARG` is handled explicitly; other
native failures remain errors.

The RPC accepts a decimal HWND and owner PID, never an arbitrary style mask.
Host checks the requested PID against Main's injected PID and verifies the live
HWND owner before mutation. Share this validation with the corner RPC. No raw
handle or new channel is exposed to renderer, preload, plugins, or remote clients.

Main awaits initial application before showing the window and reapplies after
show, restore, maximize, unmaximize, and leaving fullscreen. Active fullscreen
is excluded; closing cancels queued work and subscriptions. Errors are logged
without preventing startup, and later transitions can retry with the current
Host. Existing minimum sizes, persistence, resizing, corners, fullscreen
interlocks, and maximize/work-area correction remain unchanged.

## Consequences

`test:e2e:window-snap` exercises the production Main service and compiled Host in
an isolated profile. It checks keyboard snapping, physical titlebar drag,
client-edge pixels, native edge resize/minimums, maximize/minimize/restore, and
fullscreen/restore. Both the client and DWM-visible maximized frame must match
the work area; invisible resize margins in `GetWindowRect` are not overflow.

`--baseline` omits service installation and must fail the keyboard-snap check.
`--prepare <directory>` prepares a fixture for an existing Windows runtime and
is not a passing test. `--legacy-surface` exercises the transparent/shape path
on the available Windows version, not a real Windows 10 installation.
`--external-pointer` lets an existing remote-desktop input adapter acknowledge
`pointer-request.json` through `pointer-response.json` with the same `runId`, `id` and
`ok: true`. Native geometry/pixel assertions are identical for both input paths;
the fixture never treats an input acknowledgement alone as success.

`--matrix --artifacts <new-directory>` runs the expected failing baseline and
passing candidate as one acceptance job. The portable `run.ps1` and Windows
workflow retain revision/hash provenance, results, logs and pixel captures on
failure as well as success. A baseline startup/input failure cannot qualify
the reproduction. See [independent replay](../project/windows-native-snap-replay.md).

The renderer's custom maximize button still needs separate `HTMAXBUTTON`
integration for hover-triggered Snap Layouts. This keyboard/drag fix introduces
no global key interception or renderer snapping implementation. Requalify native
layout and pixels on Electron upgrades: separating its layout option from the
HWND styles is deliberate.

References: [Electron style handling](https://github.com/electron/electron/blob/v43.6.0/shell/browser/native_window_views.cc#L395-L411),
[DWM border attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).
