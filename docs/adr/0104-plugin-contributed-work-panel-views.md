# ADR 0104: Plugin-contributed work panel views

- Status: Accepted
- Date: 2026-08-19
- Deciders: PI-Desktop core
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0033](0033-internal-dock-work-panel.md) ·
  [ADR 0122](0122-reserve-native-width-while-work-panel-visible.md) ·
  [ADR 0081](0081-host-owned-plugin-panel-chrome.md) ·
  [ADR 0092](0092-plugin-owned-panel-surface.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [07-plugins](../spec/07-plugins/README.md) ·
  [04-ux/08-component-spec §5](../spec/04-ux/08-component-spec.md)

## Context

Before ADR 0108 removed the interactive terminal, the right work panel exposed
four capabilities — Review, Terminal, Browser, Files (ADR 0019) — as a
hard-coded list in the renderer: a `HEADER_TOOLS` constant, a closed
`WorkPanelTabKind` union, and a four-way branch on tab kind in the panel body.
Adding any new surface meant changing host code.

## Decision

1. **A plugin declares work panel surfaces with `contributes.views`.** Each
   entry carries an `id`, a `title` (plain or `{ en, "zh-CN" }`), an optional
   `icon` token, an HTML `entry` relative to the plugin, and an optional
   `order`.

2. **A view is rendered as a `WebContentsView` owned by the main process**,
   attached to the main window and positioned from a renderer-measured rect —
   the mechanism the preview browser has used since ADR 0019/0033.

3. **The renderer is the visibility authority.** A `WebContentsView` composites
   above renderer content, so the panel hides every native surface — the browser
   and any plugin view alike — whenever it is not the active tab, the panel is
   animating, the divider is being dragged, or a blocking overlay is open.

4. **An embedded view drops the window-control chrome.** A docked view has no
   window to minimize, maximize, or drag, so the preload skips the three-button
   capsule and the 46px safe area that ADR 0092 defines, and publishes
   `--pi-plugin-titlebar-height: 0px` instead of `46px`.

5. **Icons are tokens from a host-owned closed list**, never plugin-supplied
   markup.

6. **The view list is filtered by activation scope.** This differs deliberately
   from `pluginThemes`, which is *not* scope-filtered because the selected theme
   is one global app setting.

7. **Views are cached, bounded, and tied to the plugin's lifetime.** A view
   survives tab switches so a plugin keeps its scroll position and in-page
   state, up to four live views, evicting the least recently shown and never the
   one on screen.

## Consequences

- The work panel becomes an extension point rather than a fixed set.
- A plugin's storage is one thing regardless of placement, because a view and
  that plugin's detached window share a partition.
- `windowForSender` must scan windows directly instead of resolving a plugin id
  first: a docked view now also resolves to a plugin id, and routing window
  controls through that would let a docked view close the same plugin's separate
  window.
- The z-order caveat ADR 0019 accepted for the browser now applies to every
  plugin view.
- Four live `WebContentsView`s is four extra renderer processes at worst.

## Alternatives considered

### An `<iframe>` inside the host renderer

Rejected. It would z-order correctly and need no bounds syncing, but Electron
cannot give an iframe its own session partition, so the plugin page would share
the host renderer's process and storage.

### Plugin-supplied React components rendered by the host

Rejected outright. It would put third-party code in the host renderer with
access to the app's own state and IPC bridge, discarding the entire plugin trust
boundary for a rendering convenience.

### Reuse `ui.panel` and let the host decide where to show it

Rejected. A panel is one surface per plugin with a window's dimensions and
title; a view is one of several, sized by the panel column, and needs its own
menu label, icon, and order.

### Both, selected by a `isolation: "process" | "inline"` manifest field

Rejected for this change.
