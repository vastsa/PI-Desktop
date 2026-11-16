# ADR 0257: Host-mediated real-time capabilities for plugins

## Status

Accepted for implementation.

## Context

A plugin that wants to behave like an always-on voice assistant needs four
capabilities the plugin runtime does not offer today. Each one would otherwise
force a plugin out of the host's control:

- `ui.microphone` grants a *visible* plugin surface an audio-only `media`
  permission inside its own Chromium session.
- `globalShortcut` is used in exactly two places, both owned by the app
  (`bootstrap/launcher.ts`), with a Windows low-level hook as the fallback for
  `Alt+Space` in host-core.
- `pi.net.fetch` is confined to `manifest.net.domains` but carries one request
  and one response; it cannot hold a long-lived frame stream.
- The plugin host process is a Node `utilityProcess`; the plugin itself runs
  inside that process.

## Decision

1. Four permissions are added additively: `audio.capture.background` (high),
   `audio.playback.background` (medium), `keyboard.globalShortcut` (medium),
   `net.websocket` (high).

2. Devices and transports are host-owned.

3. System-wide shortcuts stay inside the host's registration model.

4. `net.websocket` connects are confined by the same `manifest.net.domains`
   allowlist and the same `assertEgress` chokepoint as `pi.net.fetch`.

5. Fail closed, and release on every exit path.

6. The host bounds every stream: one input stream per plugin, a bounded frame
   queue with backpressure and dropped-frame accounting, bounded send and
   receive buffers, a maximum frame size, and a maximum socket count.

7. Audit records the operations that change authority — open and close of an
   input, open, stop and close of an output, shortcut register and unregister,
   socket connect and close — with plugin id, operation, result, and timestamp.

8. Existing Control semantics are unchanged.

9. Delivery is staged under this single decision.

## Consequences

- The plugin surface grows by four permissions and three host API namespaces
  (`pi.audio`, `pi.keyboard`, `pi.net.websocket`).
- Background audio adds a second audio path to the app that is not the
  renderer's own playback.
- A signed macOS build cannot capture audio until the microphone usage string
  and the audio-input entitlement are added to packaging; background playback
  works without them.
- Because the plugin process is a Node process, these permissions govern what
  the host *provides* and audits, not what the process could technically reach.

## Alternatives

- Hand plugins a `MediaStream` or a Node stream.
- Keep an invisible panel alive to own the audio.
- Move voice into a dedicated sidecar process.
- Reach system-wide shortcuts through a low-level keyboard hook on every
  platform.
