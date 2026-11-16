# ADR 0159: Generated plugin settings and plugin-local shortcuts

- Status: Accepted
- Date: 2026-08-13

## Context

Plugins could declare and read their own settings, but users had no standard
way to edit them. The next known setting is a shortcut, and registering plugin
shortcuts globally would widen the collision and lifecycle surface before the
settings contract is stable.

## Decision

`contributes.settings` is the single source for the generated settings UI,
supporting `string`, `number`, `boolean`, `select`, `json`, and `shortcut`. A
shortcut setting names a plugin command and is fixed to `scope: "plugin"`,
editable on the installed plugin page, and active only while the PI-Desktop
window is focused; the host re-checks plugin activation scope before running
the command. Values are validated and stored in the plugin-private settings
file, announced to the plugin as `plugin:settingsChanged`. Secret settings
stay rejected until a secure storage contract exists.

## Consequences

- Plugin authors ship a settings surface without a custom page.
- The application shortcut map stays authoritative.
- Global plugin shortcuts need a separate decision.
