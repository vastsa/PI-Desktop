# ADR 0275: A floating widget placement for plugin panels

- Status: Accepted for implementation
- Date: 2026-09-17
- Related: [ADR 0081](0081-host-owned-plugin-panel-chrome.md) · [ADR 0092](0092-plugin-owned-panel-surface.md) · [ADR 0093](0093-plugin-panel-strict-drag-band.md) · [ADR 0110](0110-plugin-panel-chrome-spacing-contract.md)

## Context

Every plugin panel is a frameless `BrowserWindow` with a host drag band and one
three-control capsule in its top-right corner (ADR 0092, ADR 0093, ADR 0110). That
grammar suits a panel showing content but not a plugin whose whole interface is a
small round companion such as a voice orb, a timer, or a status light: the host
paints an opaque background, forces a rectangular minimum size, and draws the
capsule over the page.

## Decision

A manifest may declare `"ui": { "shape": "widget" }`; `"panel"` stays the default,
and an absent or `"panel"` value keeps today's behavior. A widget window is
transparent with no shadow, frame, maximize, fullscreen, or taskbar entry, and the
plugin draws its own silhouette, shadow, and glow. A widget has no band and no
capsule: the preload publishes `--pi-plugin-titlebar-height: 0px`, never applies
the legacy additive offset, and installs the ADR 0093 segment-map drag over the
whole window, so empty space drags while standard controls and elements marked
`data-pi-plugin-no-drag` stay clickable. Because the capsule is the panel's only
close affordance, the host owns an equivalent menu behind the widget's context
menu with close, minimize, and an always-on-top toggle, travelling on the existing
sender-validated window-control channel as one new `contextMenu` action, so
`window.pluginBridge` gains no window primitive. `ui.width` and `ui.height` are
honoured down to a widget minimum, `ui.alwaysOnTop` defaults to `false`, and
`ui.resizable` defaults to `false` for a widget. The preload publishes the
placement as `document.documentElement.dataset.piPluginPanelShape` (`panel` |
`widget` | `view`) before page scripts run, and `manifest.ui.shape` is validated at
install by the Plugin SDK and parsed by host-core's `PluginUiMeta` so the Rust
catalog and TypeScript host agree. Nothing else about the plugin surface changes,
and a widget needs no new permission.

## Consequences

- A plugin can be a floating orb that is transparent, small, optionally
  always-on-top, draggable from empty space, and closable from a host menu.
- The band, capsule, and spacing contract stay identical for panels and docked
  views, so existing plugins are unaffected.
- One more pointer rule to document: a clickable element is either a standard
  control or carries `data-pi-plugin-no-drag`.
