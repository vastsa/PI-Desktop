# 07. Process Model

## 1. Processes

MVP target topology:

```text
PI-Desktop.app
├── Electron Main
│   ├── Renderer (React UI)
│   ├── Rust host-core sidecar
│   └── Node pi agent sidecar
```

## 2. Ownership

| Process | Owns |
|---|---|
| Electron Main | window lifecycle, cross-platform tray integration, IPC fan-in/out, child process supervision, fixed-feed app update lifecycle |
| Renderer | UI only |
| Rust host-core | DB, tools, permissions, immutable Plan/Goal artifacts/`plan_approvals` execution fields, shell catalog, plugin host services, secrets adapters |
| Node pi sidecar | pi agent loop, provider streaming, tool-call planning |

## 3. Boot order

Boot begins with a single-instance lock. One data directory admits exactly one
app process: host-core owns `pi.sqlite` exclusively (D002), Electron main owns
the persistence outbox and the log tree beside it, and the tray, the global
launcher shortcut, and the updater are singletons of the running desktop. A
launch that does not take the lock quits before it creates a window, a tray, a
log line, or a child process; the instance that holds the lock restores and
focuses its main window from `second-instance`, recreating a window that was
closed or hidden into the tray, exactly as the tray's Show action does. The lock
is Electron's, so its scope is `userData` — derived from the application name,
which is therefore set before the request — rather than the data directory: a
run pointed at its own `PI_DESKTOP_DATA_DIR` (E2E harnesses, the capture rig, a
side-by-side profile) shares no database, outbox, or logs with the default
installation and stays launchable while one is running (D236, ADR 0094).

1. Electron main starts
2. Load English locale defaults
3. Spawn Rust host-core
4. `app.handshake` with host-core
5. Spawn Node pi agent sidecar
6. Connect agent sidecar tool-bridge to host-core via main
7. Create main window / renderer
8. Renderer performs `app/getVersion` healthcheck through main

If step 3–4 fails: block app with recovery message. Before a successful host
boot serves RPC, host-core transactionally marks prior pending approvals and
queued/running `plan_approvals` execution states interrupted and aborts their
running turns. This internal process-epoch fence is not serialized or sent over
the protocol.

## 4. Crash policy

| Crash | Policy |
|---|---|
| Renderer crash | reload window, keep host/agent processes; same-host reload restores only live pending Plan/Goal approvals and their deadlines, not terminal cards |
| Rust host crash | mark app degraded, interrupt pending/queued/running approval work, keep pending sessions in their contract mode (Plan or Goal) and already-approved sessions in Agent, attempt restart host, and fail active sessions closed |
| Node agent crash | abort active turns and live approval waiters/queue entries, keep pending sessions in their contract mode, preserve already-approved Agent mode in Rust, restart sidecar, and never replay an execution |
| Electron main crash | full app exit |

Supervision parameters (implemented in Electron main):

- Child exit rejects all in-flight RPCs for that child immediately (no 130s timeout wait).
- Auto-restart with exponential backoff `0.5s → 1s → 2s` (cap 4s).
- At most **3 restarts per 2-minute window** per child; beyond that the app
  stays degraded and emits `hostStatus { ok: false, component, fatal: true }`.
- Restart supervision is single-flight per child. A host process has a unique
  generation; stale generation requests and notifications are rejected before
  they reach the current bridge.
- Host persistence appends are buffered in an Electron-main-owned outbox while
  the host is unavailable and flushed sequentially after a new handshake. A
  missing sessions row is restored from the live transcript (or created as a
  stub) before those appends apply; deleting a session drops its outbox
  entries (D318).
- Host-core's stdin/stdout control path uses one dedicated OS thread per
  direction rather than Tokio's dynamic blocking pool. Transient pipe resource
  errors are retried; control-thread creation failures are surfaced as a boot
  error, so OS thread pressure cannot become an unhandled host panic. The
  login-shell PATH probe is best effort and falls back to the inherited PATH if
  its helper thread cannot be created.
- Renderer is notified on every transition via the `hostStatus` event:
  `{ ok, component?: "host" | "sidecar", restarting?, restarted?, fatal?, message? }`.
- Renderer notifications are best-effort. A disposed render frame — window
  closed while the app keeps running in the tray/Dock, or a teardown race where
  the frame dies before `webContents.isDestroyed()` flips — is dropped, never
  raised: supervision and restart proceed with no window attached.
- An unexpected sidecar exit is logged together with the sidecar's last stderr
  lines (ring-buffered in main), so a crash without a stack trace still leaves
  its final output in the report.
- Every rejection that only reports a gone transport — refused before it was
  sent, or in flight when the transport closed — carries
  `errorCode: HOST_UNAVAILABLE`, so a caller classifies routine teardown by code
  rather than by matching message text.
- Reads of host-owned registries that only add optional context to a launch or a
  panel (MCP servers, user skills, user subagents) check transport availability
  first and drop a `HOST_UNAVAILABLE` rejection quietly, degrading to empty. A
  dead transport during shutdown or between restarts is routine; logging it at
  `warn` files it under the same line as a registry that genuinely cannot be
  read.
- A renderer panel backed by a host-owned registry reloads on
  `hostStatus { ok: true }`, so a call that lost a race with teardown or a
  restart does not leave the panel showing a transport error for a registry that
  is fine.
- Intentional shutdown (quit/dispose) never triggers restart.

## 5. Shutdown order

1. Reject new prompts
2. Flush the in-flight reply checkpoints, then abort active turns through the
   sidecar and wait, bounded (2 s total), for their aborted final rows to
   drain through the persistence outbox while host-core is still alive (D299)
3. Interrupt pending/queued/running Plan and Goal work and reject late responses
4. Unload plugins
5. Stop Node agent sidecar
6. Flush/close Rust host DB
7. Stop Rust host
8. Dispose update polling
9. Close windows / exit

A quit that runs out of its budget logs `quit before streaming replies settled`
and proceeds; the next host boot promotes whatever checkpoint remains. An
unexpected sidecar exit takes the same recovery path immediately: the last
checkpoint of every running session is flushed and `session.endTurn` is asked
to `recoverInflight`, so the streamed text becomes the turn's `aborted` row
instead of vanishing with the process.

Minimizing the main window is a resident-shell action, not an application
shutdown. On Windows/Linux, explicit application minimize actions use the
native taskbar transition and keep the process alive; clicking the Windows
focused taskbar button uses the same transition and keeps the taskbar entry,
while clicking it again restores/focuses the same window. macOS native
minimize remains tray-resident. The tray owns restore/focus for tray-hidden
windows and an explicit Quit action. Quit from the tray, the existing close
path, or an update install still enters the normal shutdown sequence above;
destroying the tray happens during `before-quit` so shutdown cannot be
intercepted by a stale shell affordance.

On macOS the app runs under the regular (foreground) activation policy for its
whole lifetime, so it is always listed in the Dock and Cmd+Tab: Main never
transforms the process type, and the always-on-top plugin launcher joins every
Space with `skipTransformProcessType` rather than by becoming an accessory app.
Because macOS only emits Electron's `activate` for a Dock reopen, Main also
restores a tray-hidden window from `did-become-active` when no window is
visible, which covers Cmd+Tab and App Exposé without pulling the main window in
front of the launcher or a plugin panel (ADR 0086).

`updates/install` invokes Electron's quit-and-install path only after an update
reaches `downloaded`. Electron still emits `before-quit`, so the normal
sidecar/host shutdown sequence runs before the updater replaces the app.

## 6. Dev vs release

### Dev
- Electron via electron-vite
- Rust via `cargo run` binary path
- Node via system Node (`>= 22.19`)
- `desktop` `predev` rebuilds every workspace dependency in topological order
  (`shared`, `i18n`, `plugin-sdk`, and `agent-runtime`) before host-core and
  Electron startup; Electron must never compile against or load stale ignored
  package artifacts from an earlier source revision
- Electron 43+ no longer installs its binary during `pnpm install`;
  `scripts/dev-electron.mjs` resolves the development host through the
  `electron` package entry, which downloads and extracts the binary on demand
  at first dev boot

### Release
- package Electron app
- ship Rust host binary in resources (`Resources/bin/pi-desktop-host-core`)
- agent sidecar runs the bundled `agent-runtime/sidecar.js` on the Electron
  binary itself with `ELECTRON_RUN_AS_NODE=1` — no separate Node runtime is
  shipped (resolves **D008**)
- `Resources/agent-runtime/sidecar.js` is the sidecar's only independent
  release entry. ASAR does not carry a second complete
  `@pi-desktop/agent-runtime` package tree; Electron Main may inline the
  pure-JS helpers it calls without changing process or protocol ownership
- renderer dependencies ship through Vite output rather than duplicate raw
  package trees; no interactive PTY native module is packaged
- packaged builds use the Main-owned update controller. macOS and non-AppImage
  Linux are manual-delivery modes; Windows NSIS and Linux AppImage use the
  in-app feeds published by D126 tag releases

## 7. Acceptance

1. Clean boot path documented and scriptable
2. Host crash does not silently continue tool execution
3. Agent crash does not corrupt SQLite
4. A host crash does not create a persistence error storm or replay a completed
   message twice.
5. Host/sidecar crash never turns a pending Plan or Goal approval into Agent
   execution;
   restart recovery leaves it interrupted and the durable session in its
   contract mode
6. A queued/running execution that was already approved is interrupted without
   replay and its durable session remains Agent
7. Bash timeout/abort shuts down the complete child process tree
