# ADR 0275: A floating widget placement for plugin panels

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0081](0081-host-owned-plugin-panel-chrome.md) ·
  [ADR 0092](0092-plugin-owned-panel-surface.md) ·
  [ADR 0093](0093-plugin-panel-strict-drag-band.md) ·
  [ADR 0110](0110-plugin-panel-chrome-spacing-contract.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

Every plugin panel is a frameless `BrowserWindow` that reserves a 46px host drag
band and carries one three-control capsule in its top-right corner (ADR 0092,
ADR 0093, ADR 0110). That grammar suits a panel that shows content, and does not
suit a plugin whose whole interface is a small round companion — a voice orb, a
timer, a status light.

Such a plugin cannot exist today. The host paints an opaque background, forces a
360×280 minimum, and draws the capsule over the top of the page. What an author
gets is a rectangle with a toolbar strip, not a floating sphere; the transparent
strip that makes the panel chrome work reads as a seam around a shape that is not
a rectangle at all. Electron can already host a transparent window, and the
plugin surface itself — preload bridge, session partition, permission gate, egress
policy — needs no change to allow it.

## Decision

1. A manifest may declare `"ui": { "shape": "widget" }`. `"panel"` stays the
   default; an absent or `"panel"` value keeps today's behavior unchanged.
2. A widget window is `transparent: true` with a fully transparent
   `backgroundColor`, `hasShadow: false`, `frame: false`, `maximizable: false`,
   `fullscreenable: false`, and `skipTaskbar: true`. The plugin draws its own
   silhouette, shadow, and glow.
3. A widget has no 46px band and no capsule. The preload publishes
   `--pi-plugin-titlebar-height: 0px`, never applies the legacy additive offset,
   and instead installs a drag map over the whole window: empty space drags,
   while standard controls and every element marked `data-pi-plugin-no-drag`
   stay clickable. The mechanics are the paint-through segment map of ADR 0093,
   applied to the full rectangle.
4. The capsule is the panel's only close affordance (ADR 0093 §4), so the host
   owns an equivalent menu behind the widget surface's own context menu: close,
   minimize, and an always-on-top toggle. It travels on the existing
   sender-validated window-control channel as one new `contextMenu` action, so
   `window.pluginBridge` still gains no window primitive.
5. `ui.width` / `ui.height` are honoured down to 120×120 for a widget (a panel's
   minimum stays 360×280). `ui.alwaysOnTop` defaults to `false`; `ui.resizable`
   defaults to `false` for a widget and `true` for a panel.
6. The preload publishes the placement as
   `document.documentElement.dataset.piPluginPanelShape` (`panel` | `widget` |
   `view`) before page scripts run, so one HTML entry can serve every placement
   without a bridge round trip.
7. The plugin surface is otherwise unchanged: same preload, same
   `pluginBridge` channels, same permission gate, same per-plugin session
   partition, same egress policy, same localization rules. A widget needs no new
   permission.
8. `manifest.ui.shape`, `ui.alwaysOnTop`, and `ui.resizable` are validated at
   install by the Plugin SDK, carried in the shared manifest type, and parsed by
   host-core's `PluginUiMeta`, so the Rust catalog and the TypeScript host agree
   on the contract.

## Consequences

- A plugin can be a floating orb: transparent, small, always-on-top when it asks
  for it, draggable from its empty space, and closable from a host menu even when
  the plugin never drew a close button.
- The 46px band, the capsule, and the v2 spacing contract stay exactly as they
  are for panels and docked views; existing plugins and installed packages are
  unaffected.
- Placement is a per-plugin manifest choice, not a per-page one: the same HTML
  entry may serve a panel, a widget, and a docked view by reading the published
  placement and the titlebar variable.
- A widget surface has one more pointer rule to document: an element that must
  receive clicks is either a standard control or carries
  `data-pi-plugin-no-drag`; everything else drags the window.
