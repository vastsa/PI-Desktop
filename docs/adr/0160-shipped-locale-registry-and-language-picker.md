# ADR 0160: Shipped locale registry and searchable language picker

- Status: Accepted (amended by ADR 0182)
- Date: 2026-09-05
- Related: D012, D073, ADR 0009

## Context

Language was a row of preview cards (Auto / 简体中文 / English), so every new
locale needed a hard-coded card, sample glyph, and catalog keys for its name.
The product now ships more than two UI locales, starting with Turkish.

## Decision

`@pi-desktop/i18n` owns a `supportedLocales` registry of id, native name, and
English name, `resolveLocale` maps OS tags onto it, and `catalogs[locale]` is
the lookup for the renderer, application menu, tray, and native dialogs.
`AppSettings.language` is `"auto"` plus every registry id, where auto follows
`app.getLocale()` through the sandboxed preload bridge, and Settings → General →
Appearance keeps Theme as preview cards but shows Language as a searchable
picker that pins Auto with the detected native name. Plugin
`PluginLocalizedString` still requires `en` and `zh-CN` with English fallback,
and the changelog follows shipped shell locales when a translation exists.

## Consequences

- Adding a UI locale is a catalog file, a registry row, an
  `AppSettings.language` member, and an Electron locale pack.
- Native names stay findable even when the current UI language is unknown.
- Plugins and release notes need not ship every new shell locale on day one.

## Alternatives

- Keep wrapping preview cards: rejected, they are unreadable past a few options.
- Require plugins to add every shipped locale: rejected, it breaks existing
  manifests for a shell translation.
