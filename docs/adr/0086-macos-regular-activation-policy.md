# ADR 0086: Keep macOS on the regular activation policy

- Status: Accepted
- Date: 2026-08-14
- Deciders: PI-Desktop core
- Related: D223, E2E-127, ADR 0072, ADR 0078, ADR 0080

## Context

The global plugin launcher (ADR 0072) is a frameless always-on-top panel that
should appear over whatever the user is doing, so its window asked Electron for
`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. On macOS that
option is not a per-window flag: Electron implements it by calling
`TransformProcessType(kProcessTransformToUIElementApplication)` on the whole
process, because macOS 10.14 and later only let accessory applications float
windows above another app's fullscreen Space.

## Decision

1. PI-Desktop is a regular (foreground) macOS application for its entire
   lifetime.
2. The launcher keeps its collection behavior: it joins every regular Space and
   floats above PI-Desktop's own fullscreen window.
3. macOS activation restores the shell through `did-become-active` as well as
   `activate`, gated on a booted, non-quitting app with no visible window.
4. Tests assert the launcher call shape and the activation handler, so a future
   window option cannot silently make the app accessory again.

## Consequences

- The app is always reachable from the Dock, Cmd+Tab, App Exposé, and the tray.
- The launcher cannot overlay another app's fullscreen Space.
- Panel focus is unchanged: `show()` activates the app and makes the panel key
  under both policies, so ADR 0080's latency work is untouched.

## Alternatives

- Toggle the policy around each launcher show (`app.dock.hide()` before,
  `app.dock.show()` after).
- Drop `visibleOnFullScreen` entirely.
- Ship PI-Desktop as an `LSUIElement` tray app.
