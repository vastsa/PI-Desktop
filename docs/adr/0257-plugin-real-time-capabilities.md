# ADR 0257: Host-mediated real-time capabilities for plugins

## Status

Accepted for implementation.

## Context

A plugin that wants to behave like an always-on voice assistant needs four
capabilities the plugin runtime does not offer today. Each one would otherwise
force a plugin out of the host's control:

- `ui.microphone` grants a *visible* plugin surface an audio-only `media`
  permission inside its own Chromium session. It cannot run with no page open,
  and a page is not a lifecycle this app can keep alive in the background.
- `globalShortcut` is used in exactly two places, both owned by the app
  (`bootstrap/launcher.ts`), with a Windows low-level hook as the fallback for
  `Alt+Space` in host-core. A plugin has no path to a system-wide accelerator,
  and the plugin-scoped shortcut setting is deliberately window-local.
- `pi.net.fetch` is confined to `manifest.net.domains` but carries one request
  and one response; it cannot hold a long-lived frame stream.
- The plugin host process is a Node `utilityProcess`; the plugin itself runs
  inside that process. "Not exposed by the host API" is a contract enforced by
  the broker, not a sandbox.

The four capabilities are therefore added as host-owned services behind
explicit permissions, following the existing broker, permission-gateway and
audit model rather than widening what plugin code may touch.

## Decision

1. Four permissions are added additively: `audio.capture.background` (high),
   `audio.playback.background` (medium), `keyboard.globalShortcut` (medium),
   `net.websocket` (high). `ui.microphone` keeps its panel-scoped meaning and is
   not widened. Manifests, install copy, devkit checks, the renderer risk map
   and the validators (TypeScript and Rust) gain the same entries.

2. Devices and transports are host-owned. Plugins exchange typed frames — PCM16
   in and out, text and binary messages — through host APIs. No `MediaStream`,
   device handle, Node stream, socket object, or native handle crosses the
   boundary, and no plugin code runs inside the audio path.

3. System-wide shortcuts stay inside the host's registration model. A plugin
   declares `contributes.globalShortcuts` (at most 8 entries, each mapping one
   accelerator to one of its own declared commands) and may adjust that set at
   runtime through `pi.keyboard.*`. Registration is refused, never taken over:
   `SHORTCUT_CONFLICT` for an OS-reserved binding, one the app itself spends,
   or one another plugin holds; `SHORTCUT_UNAVAILABLE` when the platform
   refuses; `INVALID_ACCELERATOR`; `LIMIT_EXCEEDED`. A plugin cannot monitor
   keys, read raw events, or install a hook — the only thing an accelerator can
   do is run a command that belongs to that plugin.

4. `net.websocket` connects are confined by the same `manifest.net.domains`
   allowlist and the same `assertEgress` chokepoint as `pi.net.fetch`. The host
   owns the socket, so an undeclared domain, a loopback or private host not in
   the allowlist, and a redirect to an undeclared host are refused for exactly
   the same reasons they are refused today.

5. Fail closed, and release on every exit path. An undeclared or ungranted
   capability denies the call and is audited. Plugin disable, unload, crash,
   permission revocation, and app exit stop capture, drop queued playback, close
   sockets, and unregister accelerators; none of them may leave an orphan
   device, process, listener, or timer behind.

6. The host bounds every stream: one input stream per plugin, a bounded frame
   queue with backpressure and dropped-frame accounting, bounded send and
   receive buffers, a maximum frame size, and a maximum socket count.

7. Audit records the operations that change authority — open and close of an
   input, open, stop and close of an output, shortcut register and unregister,
   socket connect and close — with plugin id, operation, result, and timestamp.
   It never records audio bytes, message bodies, request headers, tokens, or
   keys.

8. Existing Control semantics are unchanged. A voice assistant drives the app
   through `pi.desktop.*` exactly as any other plugin does; dangerous
   operations keep their native confirmation even when a caller passes
   `confirm: true`, and `session/collaboration/*` remains reachable only from
   an authenticated plugin agent tool invocation.

9. Delivery is staged under this single decision. The first change implements
   the permission plumbing for all four capabilities and the full
   `keyboard.globalShortcut` runtime; `net.websocket` ships in the same line of
   work. The two audio permissions are declared and their `pi.audio` surface is
   callable — the permission gate still runs first — but the device service is
   not implemented, so every authorized call is answered with a coded
   `UNSUPPORTED` refusal, audited, rather than silently degrading; the two
   synchronous registration helpers throw the same code. That refusal is the
   part a later change replaces.

## Consequences

- The plugin surface grows by four permissions and three host API namespaces
  (`pi.audio`, `pi.keyboard`, `pi.net.websocket`). The permission matrix, install
  dialog copy in every shipped locale, devkit checks, and both validators must
  stay in sync from now on.
- Background audio adds a second audio path to the app that is not the
  renderer's own playback. It must stay off the main thread and be released
  deterministically, which is why the device is host-owned in this decision.
- A signed macOS build cannot capture audio until the microphone usage string
  and the audio-input entitlement are added to packaging; background playback
  works without them. Deployment stays incomplete until that is done.
- Because the plugin process is a Node process, these permissions govern what
  the host *provides* and audits, not what the process could technically reach.
  The existing note that the plugin sandbox is a contract, not a kernel
  boundary, remains true.

## Alternatives

- Hand plugins a `MediaStream` or a Node stream. Rejected: it grants device and
  process authority the host cannot bound, audit, or release.
- Keep an invisible panel alive to own the audio. Rejected: renderer throttling
  and teardown would drop frames silently, and the microphone would outlive any
  component the user can see.
- Move voice into a dedicated sidecar process. Rejected: it duplicates the
  plugin lifecycle, permission model, and packaging surface for no gain.
- Reach system-wide shortcuts through a low-level keyboard hook on every
  platform. Rejected: accelerator → own command is all a plugin needs, and a
  hook is precisely the keylogger-shaped surface the security model forbids.
