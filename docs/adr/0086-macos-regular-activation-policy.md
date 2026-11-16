# ADR 0086: Keep macOS on the regular activation policy

- Status: Accepted
- Date: 2026-08-14
- Related: ADR 0072, ADR 0078, ADR 0080, D223

## Context

The global launcher (ADR 0072) asked Electron for
`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, which on macOS is
a process-wide `TransformProcessType` call: the app became a UIElement app and
disappeared from the Dock and Cmd+Tab. ADR 0080 then moved creation into boot
warm-up, so this ran on every launch, and because macOS emits Electron's
`activate` only from `applicationShouldHandleReopen:`, a tray-hidden window had no
keyboard route back.

## Decision

1. PI-Desktop stays a regular foreground macOS application for its lifetime. No
   code path may transform the process type: the launcher passes
   `skipTransformProcessType: true`, and `app.dock.hide()` and
   `setActivationPolicy` stay out of Main. Dock and Cmd+Tab presence is an
   invariant, not a side effect of one window's options.
2. The launcher keeps its collection behavior and floats above PI-Desktop's own
   fullscreen window, but it does not overlay another application's fullscreen
   Space, which macOS reserves for accessory apps.
3. macOS activation restores the shell through `did-become-active` as well as
   `activate`, gated on a booted, non-quitting app with no visible window, so
   Cmd+Tab and App Exposé recover a tray-hidden window without dragging the main
   window forward when only the launcher or a plugin panel is shown.
4. Tests assert the launcher call shape and the activation handler so a future
   window option cannot silently make the app accessory again.

## Consequences

- The app is always reachable from the Dock, Cmd+Tab, App Exposé, and the tray.
- Invoking the launcher from another app's fullscreen Space activates PI-Desktop
  and switches Spaces, which is ordinary foreground behavior.
- Panel focus and ADR 0080's warm-up latency are unchanged.

## Alternatives

- Toggle the policy around each launcher show: rejected because it flickers the
  Dock icon, adds work to the optimized path, and strands the app as accessory if
  the restore is missed.
- Ship PI-Desktop as an `LSUIElement` tray app: rejected because it contradicts
  ADR 0078's resident main window.
