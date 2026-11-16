# ADR 0343: The plugin launcher enumerates and opens local applications

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

- It reads the machine's Start Menu / `.app` bundles / `.desktop` entries.
- It starts a child process outside the app's own sandbox and permission
  gateway.
- A plugin declaring a launcher pattern would, if it could reach this, be able
  to turn "the user typed `1+1`" into "start any program on this machine".

## Decision

1. The plugin launcher may enumerate installed applications and open them, and
   only that window may do so.
2. The capability is never exposed to plugins.
3. The renderer never receives a launchable path.
4. Discovery is bounded and non-invasive.
5. The launcher's size and position live in main-process shell state (`<data
   dir>/plugin-launcher-state.json`), not in host-core.

## Consequences

- One shortcut opens "anything openable" — plugin panels and installed
  applications — in one grid that renders every source as the same rounded
  square.
- The privilege boundary is a window, not a permission: revoking it means
  removing the channel, not editing a plugin manifest.
- Because the renderer only ever holds opaque ids, the catalog is display-safe:
  it can be logged or inspected without leaking filesystem layout, and the same
  id space works on all three platforms.
- Application entries can be stale between scans.
- A user who does not want applications in the launcher still gets the scan.

## Alternatives considered

### Expose application launch to plugins

Rejected. A plugin with a panel would gain the ability to start arbitrary
programs on the user's machine, which no permission in
`13-plugin-permissions-matrix.md` describes and which install-time review could
not make safe.

### Let the renderer supply the executable path

Rejected. Even with a sender check, accepting a path makes the IPC a
general-purpose process launcher: the check protects against other renderers,
not against a compromised launcher page, and the launcher page renders
plugin-supplied names and icons.

### Store launcher geometry in host-core settings

Rejected as the wrong owner.

### Reuse the main window for the launcher instead of a second `BrowserWindow`

Rejected: the panel must float above other applications, stay focusable while
the main window is hidden, and hide on blur without touching the main window's
lifecycle.

### Fold applications into global search (`Cmd/Ctrl+K`)

Rejected. Global search owns sessions, files, settings, and commands, and is a
modal over the main window; local applications are a machine-local, potentially
600-entry list that would dominate any mixed result set.
