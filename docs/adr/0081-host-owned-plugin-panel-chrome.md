# ADR 0081: Host-owned cross-platform plugin panel chrome

- Status: Accepted
- Date: 2026-08-13
- Related: D118, D129, D218, ADR 0021, ADR 0025

## Context

Plugin panels run in separate sandboxed `BrowserWindow` instances that load
plugin-owned HTML, so they kept Electron's default frame: their titlebar did not
match the main window and differed across macOS, Windows, and Linux. The panel page
cannot be trusted with the main renderer preload, and the host chrome must not
depend on plugin CSS.

## Decision

Panels follow the main window's platform split: macOS uses `hiddenInset` with inset
traffic lights, while Windows and Linux use a frameless window with renderer-drawn
controls. The existing sandboxed plugin-panel preload injects a host-owned titlebar
into a closed Shadow DOM, renders the manifest panel title, offsets the plugin body
by the titlebar height on top of its computed padding, and publishes
`--pi-plugin-titlebar-height` for fixed or sticky plugin UI. Windows and Linux send
minimize, maximize/restore, and close as one Electron-local fixed action tuple that
Main accepts only from a live plugin panel. `window.pluginBridge` gains no window
primitives, and the session partition, sandbox, context isolation, and
permission-checked bridge stay unchanged. Controls keep localized accessible
names, visible focus, theme-aware surfaces, and reduced motion.

## Consequences

- Panels align with the application chrome on all three release platforms without
  widening plugin access.
- Plugin CSS cannot style the closed titlebar tree, though a plugin can replace its
  own document and drop the injected element without gaining a capability.
- Fixed-content panels must respect `--pi-plugin-titlebar-height`, and the private
  window-control channel stays outside host-core protocol v9.

## Alternatives

- Keep the default panel frame: preserves inconsistent chrome across platforms.
- Expose the main window-control API: would give plugins generic native-window
  authority beyond their declared capabilities.
