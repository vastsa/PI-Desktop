# ADR 0257: Host-mediated real-time capabilities for plugins

- Status: Accepted for implementation

## Context

An always-on voice-assistant plugin needs audio capture and playback, global
shortcuts, and sockets, and each would otherwise force it out of host control:
`ui.microphone` needs a visible panel, `globalShortcut` is app-owned, `pi.net.fetch`
carries one request and one response, and the plugin host's Node `utilityProcess`
broker contract is not a sandbox.

## Decision

Four additive permissions arrive — `audio.capture.background` (high),
`audio.playback.background` (medium), `keyboard.globalShortcut` (medium), and
`net.websocket` (high) — with `ui.microphone` keeping its panel-scoped meaning.
Devices and transports stay host-owned: plugins exchange typed frames (PCM16 in and
out, text and binary) through host APIs, and no `MediaStream`, device handle, Node
stream, socket object, or native handle crosses the boundary. Shortcuts stay inside the
host registration model, where a plugin declares `contributes.globalShortcuts` (at most
8, one accelerator to one of its own commands) and adjusts the set through
`pi.keyboard.*`, and registration is refused rather than taken over with
`SHORTCUT_CONFLICT`, `SHORTCUT_UNAVAILABLE`, `INVALID_ACCELERATOR`, or
`LIMIT_EXCEEDED`, never by monitoring keys or installing a hook. `net.websocket`
connects obey the same `manifest.net.domains` allowlist and `assertEgress` chokepoint as
`pi.net.fetch`, and every exit path — deny, disable, unload, crash, revocation, app
exit — releases capture, queued playback, sockets, and accelerators with no orphan
device, listener, or timer. The host bounds every stream (one input stream per plugin, a
bounded frame queue with dropped-frame accounting, bounded buffers, a maximum frame size
and socket count) and audits authority-changing operations with plugin id, operation,
result, and timestamp, never audio bytes, message bodies, headers, tokens, or keys.
Delivery is staged: permission plumbing plus the full `keyboard.globalShortcut` and
`net.websocket` runtime ship first, while `pi.audio` gates, audits, and answers
`UNSUPPORTED` until a device service exists.

## Consequences

- The surface grows by four permissions and three namespaces, so the permission
  matrix, install copy in every locale, devkit checks, and both validators must stay in
  sync.
- Background audio is a second non-renderer audio path that must stay off the main
  thread, and a signed macOS build cannot capture audio without the microphone usage
  string and audio-input entitlement.
- These permissions govern what the host provides and audits, not what the Node process
  can reach: the sandbox remains a contract, not a kernel boundary.

## Alternatives

- Hand plugins a `MediaStream` or Node stream: authority the host cannot bound, audit,
  or release.
- Use a low-level keyboard hook: that is the keylogger-shaped surface the security model
  forbids.
