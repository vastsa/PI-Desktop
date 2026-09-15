# ADR 0249 — Plugin runtime theme APIs and sidebar image token

- **Status**: Accepted for implementation
- **Date**: 2026-09-15
- **Related**: issue #352, ADR 0248, `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`

## Context

A visual theme editor plugin (Theme Studio) cannot ship the product flow users
expect against the shipped host contract:

1. **No apply API.** Theme selection only lives in Settings (`settingsSet` from
   the renderer). A plugin panel cannot switch `AppSettings.theme`, so "pick a
   theme and see it now" is impossible without leaving the panel.
2. **Static load-time registry.** `registerThemes()` reads `contributes.themes`
   once. New themes need a manifest slot and a full plugin reload; editing the
   active theme's CSS in production requires disable → enable.
3. **Hard cap of 8 themes per plugin** (`MAX_THEMES_PER_PLUGIN`), which blocks
   an unlimited user-authored library.
4. **Sidebar paint is color-only.** `--ds-bg-sidebar` feeds `color-mix` glass
   tint, borders, and macOS vibrancy. Putting `linear-gradient()` in that token
   breaks those consumers, so sidebar gradients cannot be a supported feature.

## Decision

### 1. `app.setTheme` (permission `ui.theme`)

```ts
pi.app.setTheme(themeId: "system" | "light" | "dark" | `plugin:${string}`): Promise<void>
```

Validates the id (built-in preference, or a currently registered plugin theme),
persists `AppSettings.theme` through host-core `settings.set`, then applies the
theme-only appearance reaction (`applyAppThemePreference`) that the full
settings path also reuses. That entry point touches nothing but theme state, so
`setTheme` can never disturb the locale, keybindings, or developer-mode menu
state. The renderer receives `settingsChanged` so its store stays in sync;
panels receive `appearance:changed` as today.

### 2. Runtime theme lifecycle (permission `ui.theme`, own themes only)

```ts
pi.themes.upsert({ id, label, base, css })
pi.themes.remove(themeId)
pi.themes.list()
```

- Production plugins, no unload/reload.
- CSS goes through the same `sanitizeThemeCss` + size cap as load-time.
- Ids are namespaced `plugin:<pluginId>:<themeId>`; upsert replaces label/base/css.
- Host emits `pluginChanged` (`reason: "themes"`) and refreshes panel appearance
  so an updated **active** theme restyles immediately.
- The 8-theme hard cap is removed. Abuse control remains the CSS size cap,
  sanitizer, and permission gate.

### 3. Sidebar image token

- `--ds-bg-sidebar` stays a **color**.
- New optional `--ds-bg-sidebar-image` holds a CSS `<image>` (`none` by default).
- `.sidebar` / `.sidebar-rail` use `background-color` + `background-image`.
- macOS vibrancy stacks the image layer **under** the glass sheen gradients.

## Consequences

- Theme Studio (and any `ui.theme` plugin) can apply, create, edit, and delete
  themes without a reload path.
- `ui.theme` is no longer "additive style only": it can change the active app
  theme. The permission stays low-risk because ids are host-validated and CSS
  is already sanitized.
- Specs, permissions matrix, E2E docs, and this ADR stay the contract for
  plugin authors.
