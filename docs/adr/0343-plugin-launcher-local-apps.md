# ADR 0343: The plugin launcher enumerates and opens local applications

- Status: Accepted
- Date: 2026-11-05
- Related: ADR 0072 (global plugin launcher), ADR 0080 (prewarm), ADR 0090
  (main-process shell state), ADR 0092 (plugin-owned panel surface),
  ADR 0214 (trusted extensions), issue #2085

## Context

A user pressing Alt+Space is reaching for whatever they want to open now, which is
as often an installed application as a plugin panel. Enumerating and starting
local applications has a much wider blast radius than opening a panel: it reads
platform application entries and starts child processes outside the app's own
sandbox and permission gateway, so neither a renderer-side launch API nor a
plugin-visible one may exist.

## Decision

1. Only the launcher window may enumerate and open applications, through one IPC
   surface (`pi-desktop/pluginLauncher/catalog`,
   `pi-desktop/pluginLauncher/openApp`) whose handler compares
   `event.sender.id` with the launcher's own `webContents` and rejects anything
   else with `PERMISSION_DENIED`; a missing launcher window means "not the
   launcher".
2. The capability is never exposed to plugins. No channel joins `pluginBridge` or
   the panel bridges and no application-launch member joins the Plugin SDK, so a
   plugin can receive the user's text through a launcher trigger but cannot learn
   what applications exist or start one.
3. The renderer never receives a launchable path. The catalog carries a display
   name, executable name, source tag (`start-menu` / `app-bundle` /
   `desktop-entry`), a small icon, and an opaque `app:<slug>` id, and `openApp`
   resolves that id against the host's own scan and re-checks that the target
   still exists instead of falling back.
4. Discovery is bounded and non-invasive: Main reads only well-known locations,
   never spawns a probe, caches the scan, caps the entry count and icon budget,
   drops entries whose target is gone, and draws a letter tile for plugin panels
   because `manifest.icon` is not consumed by the host.
5. Launcher size and position live in main-process shell state under the app data
   directory, following the `window-state.json` precedent from ADR 0090:
   best-effort, debounced, defensively parsed, and re-centred when a remembered
   position fits no current work area, with no host RPC, schema, or migration.

## Consequences

- One shortcut opens both plugin panels and applications in one grid, at the cost
  of no longer distinguishing them before opening.
- The privilege boundary is a window rather than a permission, and the catalog is
  display-safe because the renderer only ever holds opaque ids.
- Application entries can go stale between scans, and the launcher becomes
  platform-sensitive with its own parsers and tests; shell state gains a second
  file that is deliberately excluded from configuration export.

## Alternatives

- Expose application launch to plugins: rejected because no permission in the
  matrix describes starting arbitrary programs, and install-time review could not
  make it safe.
- Let the renderer supply the executable path: rejected because a sender check
  protects other renderers, not a compromised launcher page, and path acceptance
  would make the IPC a general-purpose process launcher.
