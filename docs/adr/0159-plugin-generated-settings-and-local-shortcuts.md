# ADR 0159: Generated plugin settings and plugin-local shortcuts

- Status: Accepted
- Date: 2026-08-13
- Decision owners: PI-Desktop desktop/plugin maintainers

## Context

Plugins already declared settings and could read/write their private settings,
but users had no standard way to edit those values. The next known setting is a
shortcut, and registering plugin shortcuts globally would expand the collision
and lifecycle surface before the plugin settings contract is stable.

## Decision

1. `contributes.settings` is the source of truth for the generated settings UI.
   Supported types are `string`, `number`, `boolean`, `select`, `json`, and
   `shortcut`.
2. A shortcut setting declares a plugin command through `command` and has the
   fixed `scope: "plugin"`. The user may edit it in the installed plugin page.
3. Plugin shortcuts are handled by the renderer only while the PI-Desktop
   window is focused. The host re-checks the plugin activation scope before
   executing the command. They are not Electron/global shortcuts.
4. The host validates values, persists them in the plugin-private settings
   file, and sends `plugin:settingsChanged` to the plugin process.
5. Secret settings remain rejected until a dedicated secure storage contract is
   designed.

## Consequences

- Plugin authors can ship a usable settings surface without bundling a custom
  configuration page.
- The existing application shortcut map remains authoritative for app-global
  behavior and plugin shortcuts cannot replace it.
- A future global plugin shortcut feature will require a separate decision for
  collision handling, OS registration, and disabled/background plugin state.
