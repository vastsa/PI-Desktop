# ADR 0339: The plugin launcher enumerates and opens local applications

- Status: Accepted
- Date: 2026-11-05
- Deciders: PI-Desktop maintainers
- Related: ADR 0072 (global plugin launcher), ADR 0080 (prewarm), ADR 0090
  (main-process shell state), ADR 0092 (plugin-owned panel surface),
  ADR 0214 (trusted extensions), `docs/spec/07-plugins/18-plugin-launcher.md`,
  `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-268), issue #2085

## Context

The plugin launcher (`Alt+Space` / `⌥+Space`) opens panel plugins. Users who
press that shortcut are usually reaching for "the thing I want to open now", and
in practice that is as often an installed application as it is a plugin panel.
A launcher that only knows about plugins makes the user remember which surface
owns which program.

Enumerating and starting local applications is a new capability with a different
blast radius than opening a plugin panel:

- It reads the machine's Start Menu / `.app` bundles / `.desktop` entries.
- It starts a child process outside the app's own sandbox and permission
  gateway.
- A plugin declaring a launcher pattern would, if it could reach this, be able
  to turn "the user typed `1+1`" into "start any program on this machine".

PI-Desktop's existing boundaries assume a renderer cannot start arbitrary
processes and a plugin can only act through the permission gateway. Both would
be broken by a naive implementation: a renderer-side "launch this path" API, or
a plugin-visible application-launch API.

The launcher window is also a floating app-shell panel, and ADR 0090 already
established where its geometry belongs: shell state written by main into the
app data directory, not host-core user data.

## Decision

1. The plugin launcher may enumerate installed applications and open them, and
   only that window may do so. The capability is one IPC surface
   (`pi-desktop/pluginLauncher/catalog`, `pi-desktop/pluginLauncher/openApp`)
   with a sender check: the handler compares `event.sender.id` with the
   launcher window's own `webContents` and rejects anything else with
   `PERMISSION_DENIED`. The main window cannot call it, and a missing launcher
   window (it is created lazily) means "not the launcher".
2. The capability is never exposed to plugins. No channel is added to
   `pluginBridge` or to the panel/work-panel bridges, and no
   application-launch member is added to the Plugin SDK. A plugin can declare
   launcher triggers and thereby receive the user's text — it cannot learn what
   applications exist or start one.
3. The renderer never receives a launchable path. The catalog carries a display
   name, an executable name, a source tag (`start-menu` / `app-bundle` /
   `desktop-entry`), a small icon, and an opaque `app:<slug>` id. `openApp`
   resolves that id against the host's own scan result and re-checks that the
   target still exists; an unknown id fails instead of falling back to anything.
   A compromised renderer can therefore open a program the host already
   discovered and the user can already see, and nothing else.
4. Discovery is bounded and non-invasive. Main reads only well-known locations,
   never spawns a program to probe, caches the scan for 5 minutes, caps the list
   at 600 entries, asks the platform for a `large` icon for the first 200 entries
   (each data URL ≤32 KiB, reused across scans through an id-keyed cache), and
   drops an entry whose target is gone. A plugin tile never has a platform icon:
   the launcher draws a letter tile for plugin panels, because `manifest.icon` is
   author-declared but not consumed by the host.
5. The launcher's size and position live in main-process shell state
   (`<data dir>/plugin-launcher-state.json`), not in host-core. It follows the
   `window-state.json` precedent from ADR 0090: best-effort, debounced,
   defensively parsed, and re-centred when a remembered position no longer fits
   any current work area. No host RPC, schema, or migration is involved.

## Consequences

- One shortcut opens "anything openable" — plugin panels and installed
  applications — with a source tag on every tile so the user can tell them
  apart even when the names collide.
- The privilege boundary is a window, not a permission: revoking it means
  removing the channel, not editing a plugin manifest. The launcher window runs
  with `contextIsolation`, `sandbox`, and no Node integration like every other
  renderer surface, so compromising it still does not yield a filesystem or
  process API.
- Because the renderer only ever holds opaque ids, the catalog is
  display-safe: it can be logged or inspected without leaking filesystem
  layout, and the same id space works on all three platforms.
- Application entries can be stale between scans. `openApp` re-checks the
  target, so a program uninstalled after the scan produces an error the caller
  can show, not a silent no-op or a wrong program.
- A user who does not want applications in the launcher still gets the scan.
  The cost is bounded (one cached directory walk per five minutes, no process
  spawns) and launcher-scope preferences can hide items without affecting the
  plugin runtime.
- The launcher becomes platform-sensitive for the first time: Start Menu
  shortcut resolution, bundle naming, and `.desktop` parsing each need their own
  parser and tests, and Windows Shortcut (`shell.readShortcutLink`) behaviour is
  an Electron dependency rather than our own code.
- Shell state now has a second file beside `window-state.json` and
  `close-behavior.json`; it is intentionally not part of configuration export,
  because it is not user data.

## Alternatives considered

### Expose application launch to plugins

Rejected. A plugin with a panel would gain the ability to start arbitrary
programs on the user's machine, which no permission in
`13-plugin-permissions-matrix.md` describes and which install-time review could
not make safe. The launcher is a user action in a user-owned window; a plugin
acting on its own behalf is a different trust level.

### Let the renderer supply the executable path

Rejected. Even with a sender check, accepting a path makes the IPC a
general-purpose process launcher: the check protects against other renderers,
not against a compromised launcher page, and the launcher page renders
plugin-supplied names and icons. Resolving an opaque id against the host's own
scan keeps the decision about *what may start* in the process that did the
discovery.

### Store launcher geometry in host-core settings

Rejected as the wrong owner. The size of one floating panel is app-shell state
produced by `BrowserWindow` events in main; host-core owns user data and durable
domain state. Storing it there would add an RPC round trip for a value only main
reads, plus a schema and migration surface for something the user never
inspects.

### Reuse the main window for the launcher instead of a second `BrowserWindow`

Rejected: the panel must float above other applications, stay focusable while
the main window is hidden, and hide on blur without touching the main window's
lifecycle. That is a window contract, and ADR 0072/0080 already chose a
dedicated prewarmed window for it.

### Fold applications into global search (`Cmd/Ctrl+K`)

Rejected. Global search owns sessions, files, settings, and commands, and is a
modal over the main window; local applications are a machine-local, potentially
600-entry list that would dominate any mixed result set. Keeping "open something
now" in the launcher and "find something in the app" in global search keeps both
lists ranked by a rule a user can predict.
