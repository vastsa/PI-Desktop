# ADR 0316: The Live Voice call bar is a docked desktop widget window

- Status: Accepted
- Date: 2026-10-01
- Deciders: PI-Desktop core
- Related: [ADR 0086](0086-macos-regular-activation-policy.md) ·
  [ADR 0275](0275-plugin-panel-floating-widget.md) ·
  [03-runtime/live-voice](../spec/03-runtime/live-voice.md) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md)

## Context

The compact call bar was AppShell chrome inside the main window. That satisfies
"in-app navigation cannot hide the call controls", but not the case users
actually hit: working in another application while a call is running. A bar
painted inside the app window is invisible the moment the app is not the
foreground window, and it can never be moved out of the app's rectangle.

The call itself cannot move with it. The main window is the call owner: it holds
the renderer-side capture gating, the `WebRTC`/PCM media, the microphone lease
and the call-scoped work. Every owner-validated Live Voice channel rejects
another window with `PERMISSION_DENIED`, and `isTrustedRendererUrl` treats a
renderer URL with a query string as untrusted — so a second window can neither
become the owner nor quietly drive the owner channels.

## Decision

1. The call chrome is drawn by its own frameless, transparent, always-on-top
   `panel` window, following the plugin launcher's window recipe — with its
   activation-policy constraint from ADR 0086: it joins every Space, floats above
   other applications, and never lets Electron transform the process type. It
   loads the existing renderer bundle through
   `?surface=live-voice-widget`, the surface dispatch the plugin launcher already
   uses, so no second HTML entry, preload or build change is introduced.
2. The bar is its own drag handle (`app-region: drag` on the bar, `no-drag` on
   its controls). The placement is remembered in `live-voice-widget.json` in the
   app data directory and clamped to the work area it was measured against; the
   window is sized to the box the widget reports for the content it draws, so a
   transparent window keeps no invisible hit area over the desktop.
3. The widget never owns the call. Main pushes the authoritative call view to it
   (`voice/live/event/widgetState`); every press travels back
   (`voice/live/widget/action`) and is executed by the main window's controller
   in the owner frame. Mute therefore still gates the renderer's own capture
   before the IPC request, and the owner contract keeps one owner per call.
4. A failure only the owner frame can observe — a refused mute, a playback retry
   that failed — is reported back (`voice/live/widget/issue`) so the bar can name
   it in place next to its verbatim `LIVE_*` code. The widget is the only call
   chrome the user sees, so nothing that used to be drawn there may disappear
   with it.
5. The main window draws no call bar. It stays the frame that runs the actions
   and keeps the details surface, which the widget's Details action opens after
   bringing that window forward.
6. The widget's channels are validated as the widget window and never enter owner
   derivation: any other renderer using them is refused exactly like any other
   untrusted caller.

## Consequences

- A call stays visible and controllable while the user works in another
  application, and the chrome can be placed anywhere on the desktop.
- One additional renderer process appears with the first call and stays warm
  while the widget is hidden; that idle cost buys a bar that appears without a
  navigation or load delay mid-call.
- The widget is not the app shell, so it does not boot the settings store. It
  applies the persisted language itself when it becomes visible, and the window
  is created with the OS locale as its starting point.
- New IPC surface: two widget channels, one owner-report channel and two events.
  The preload whitelist is derived from `IPC`, so only `packages/shared` needs
  the channel names.
- The details surface lost its in-window trigger; it is opened from the widget
  and hangs from a fixed anchor above the composer.

## Alternatives

- Keep the bar in AppShell and make it draggable inside the window: it can never
  leave the app rectangle or survive another app owning the foreground, which is
  the whole request (rejected).
- Let the widget window own the call: it would have to hold media, the
  microphone lease and the work scope, duplicating the owner contract and
  breaking the single-owner rule (rejected).
- Capture media in an offscreen renderer while the widget draws chrome: it
  contradicts the existing ownership model without buying anything the owner
  frame does not already provide (rejected).
- Draw the details surface inside the widget: its work actions need the main
  window's session, project and navigation store (rejected).
