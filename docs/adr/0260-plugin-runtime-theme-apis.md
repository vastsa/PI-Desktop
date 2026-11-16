# ADR 0260 — Plugin runtime theme APIs and sidebar image token

- **Status**: Accepted for implementation
- **Date**: 2026-09-15
- **Related**: issue #352, ADR 0248, `07-plugins/03-plugin-api.md`

## Context

A theme editor plugin cannot ship the expected flow against the shipped host
contract: theme selection lives only in Settings, `registerThemes()` reads
`contributes.themes` once at load, a hard cap of 8 themes blocks a user-authored
library, and `--ds-bg-sidebar` feeds `color-mix` glass tint and borders, so a
gradient there breaks its consumers.

## Decision

### 1. `app.setTheme` (permission `ui.theme`)

`pi.app.setTheme(themeId)` accepts `"system"`, `"light"`, `"dark"`, or
`` `plugin:${string}` ``; it validates the id, persists `AppSettings.theme`
through host-core `settings.set`, and then runs the theme-only appearance
reaction that the full settings path reuses, so locale, keybindings, and
developer-mode menu state are untouched.

### 2. Runtime theme lifecycle (permission `ui.theme`, own themes only)

`pi.themes.upsert({ id, label, base, css })`, `pi.themes.remove(themeId)`, and
`pi.themes.list()` work in production plugins without a reload. CSS passes the
same sanitizer and size cap as load-time, ids are namespaced
`plugin:<pluginId>:<themeId>`, the host emits `pluginChanged` with reason
`"themes"` and refreshes panel appearance so an active theme restyles
immediately, and the 8-theme cap is removed with the size cap, sanitizer, and
permission gate as the remaining controls.

### 3. Sidebar image token

`--ds-bg-sidebar` stays a color and a new optional `--ds-bg-sidebar-image` holds
a CSS `<image>`, `none` by default; the sidebar and rail use `background-color`
plus `background-image`, and macOS stacks the image under the glass sheen over
the opaque window surface (ADR 0332 superseded the vibrancy plate).

## Consequences

- Any `ui.theme` plugin can apply, create, edit, and delete themes without a
  reload path.
- `ui.theme` can now change the active theme, which stays low-risk because ids
  are host-validated and CSS sanitized.
- Specs and the permissions matrix remain the contract for plugin authors.
