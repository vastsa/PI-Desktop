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
bits, preserving other styles and bounds.

The RPC accepts a decimal HWND and owner PID, never an arbitrary style mask.
Host checks the requested PID against Main's injected PID and verifies the live
HWND owner before mutation.

## Consequences

`test:e2e:window-snap` exercises the production Main service and compiled Host
in an isolated profile.

`--baseline` omits service installation and must fail the keyboard-snap check.
