# ADR 0104: Plugin-contributed work panel views

- Status: Accepted
- Date: 2026-08-19
- Related: [ADR 0019](0019-work-panel-subsystems.md) · [ADR 0028](0028-session-scoped-work-panel-contexts.md) · [ADR 0033](0033-internal-dock-work-panel.md) · [ADR 0081](0081-host-owned-plugin-panel-chrome.md) · [ADR 0092](0092-plugin-owned-panel-surface.md) · [ADR 0105](0105-files-as-a-bundled-plugin.md) · [ADR 0108](0108-remove-built-in-interactive-terminal.md) · [ADR 0122](0122-reserve-native-width-while-work-panel-visible.md) · [04-ux/08-component-spec §5](../spec/04-ux/08-component-spec.md)

## Context

The right work panel exposed Review, Terminal, Browser, and Files as a hard-coded
renderer list, so adding a surface meant changing host code. Plugins have a mature
but strictly bounded UI channel that only produces a separate `ui.panel` window
(ADR 0092), so a surface belonging next to the conversation either becomes a
detached window competing for screen space or does not exist.

## Decision

1. A plugin declares work panel surfaces with `contributes.views`, each entry
   carrying `id`, `title`, an optional `icon` token, an HTML `entry`, and an
   optional `order`, gated by a new `ui.view` permission parallel to `ui.panel`.
2. A view renders as a main-process-owned `WebContentsView` positioned from a
   renderer-measured rect, reusing the plugin's sandboxed preload, its persisted
   session partition, and its `net.domains` egress filter through shared helpers so
   docked and detached placements cannot drift.
3. The renderer is the visibility authority and hides every native surface
   whenever the view is not the active tab, the panel animates, the divider drags,
   or a blocking overlay is open.
4. A docked view drops the window-control chrome and publishes
   `--pi-plugin-titlebar-height: 0px` instead of the panel value, while
   `window.pluginBridge` stays identical so one entry file serves both placements.
5. Icons are tokens from a host-owned closed list, and an unknown token degrades to
   a lettered tile rather than accepting plugin markup inside host chrome.
6. The view list is filtered by activation scope, unlike the global
   `pluginThemes`, and permission, scope, and entry existence are re-checked when a
   view opens.
7. Views are cached and tied to the plugin's lifetime: a few live views survive tab
   switches with least-recently-shown eviction, while disable, uninstall, reload,
   or crash destroys them and the renderer re-opens from the lifecycle event.

## Consequences

- The work panel becomes an extension point that third-party plugins reach by the
  same route first-party code will use.
- A view shares its plugin's session partition, so it inherits any state that
  plugin's detached window already had.
- Window-control routing must scan windows directly, so a docked view cannot close
  the same plugin's separate window.
- The z-order caveat once accepted for the browser now applies to every plugin
  view, and each live view costs an extra renderer process.

## Alternatives

- An `<iframe>` inside the host renderer: rejected, Electron cannot give it its own
  session partition, which is a weaker boundary than plugin windows have.
- Plugin-supplied React components rendered by the host: rejected, it would put
  third-party code inside the host renderer with the app's IPC bridge.
