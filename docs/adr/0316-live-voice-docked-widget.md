# ADR 0316: The Live Voice call bar is a docked desktop widget window

- Status: Accepted
- Date: 2026-10-01
- Related: ADR 0086, ADR 0275

## Context

The call bar was AppShell chrome inside the main window, which keeps controls reachable
during in-app navigation but not while the user works elsewhere, since a bar painted
inside the app window is invisible once the app is not foreground. The call cannot move
with it: the main window owns renderer-side capture gating, the WebRTC/PCM media, the
microphone lease, and call-scoped work, and every owner-validated Live Voice channel
rejects another window with `PERMISSION_DENIED`, while `isTrustedRendererUrl` treats a
renderer URL with a query string as untrusted.

## Decision

The chrome is drawn by its own frameless, transparent, always-on-top `panel` window
following the plugin launcher's recipe plus ADR 0086's activation-policy constraint, so
it joins every Space, floats above other applications, and never lets Electron transform
the process type, and it loads the existing renderer bundle through
`?surface=live-voice-widget`, needing no second HTML entry, preload, or build change. The
bar is its own drag handle (`app-region: drag`, `no-drag` on controls), placement is
remembered in `live-voice-widget.json` and clamped to the measured work area, and the
window is sized to the box the widget reports so no invisible hit area covers the
desktop. The widget never owns the call: main pushes the authoritative view over
`voice/live/event/widgetState` and every press returns as `voice/live/widget/action` to be
executed by the main window's controller in the owner frame, so mute still gates capture
before the IPC request, and a failure only the owner frame can observe is reported back
over `voice/live/widget/issue` beside its verbatim `LIVE_*` code. The main window draws
no call bar, its details surface opens from the widget's Details action, and the widget's
channels are validated as the widget window and never enter owner derivation.

## Consequences

- A call stays visible and controllable while the user works elsewhere, and the chrome
  can be placed anywhere on the desktop.
- One more renderer process appears with the first call and stays warm while hidden, and
  being no app shell it applies the persisted language when visible instead of booting
  the settings store.
- New IPC surface is two widget channels, one owner-report channel, and two events, and
  the preload whitelist derives from `IPC` so only `packages/shared` needs the names.

## Alternatives

- Keep the bar in AppShell and make it draggable: it can never leave the app rectangle.
- Let the widget own the call: it would duplicate the owner contract and break the
  single-owner rule.
