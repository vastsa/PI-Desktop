# ADR 0160: Shipped locale registry and searchable language picker

- Status: Accepted (amended by ADR 0182)
- Date: 2026-09-05
- Decision owners: PI-Desktop desktop/i18n maintainers
- Related: D012, D073, ADR 0009

## Context

The General appearance card presented language as three preview cards
(Auto / 简体中文 / English). That control does not scale: every new locale
needed a hard-coded card, sample glyph, and catalog keys for its name.
The product now ships more than two UI locales, starting with Turkish, so
the picker and the locale list have to come from one registry.

Plugin labels retain the `en` + `zh-CN` contract with English fallback.
The product changelog originally shipped those two locales; ADR 0182 adds
Traditional Chinese without requiring plugins to gain every shell locale.

## Decision

1. `@pi-desktop/i18n` owns a `supportedLocales` registry: id, native name
   (endonym, never translated), and English name. `resolveLocale` maps OS
   tags onto that list (`tr` / `tr-TR` → `tr`, Simplified Chinese tags →
   `zh-CN`, Traditional Chinese tags → `zh-TW`, else `en`).
   `catalogs[locale]` is the lookup used by the renderer, application menu,
   tray, and native consent dialogs.
2. `AppSettings.language` is `"auto"` plus every registry id. Auto still
   follows `app.getLocale()` through the sandboxed preload bridge.
3. Settings → General → Appearance keeps Theme as three preview cards.
   Language is a searchable picker row (same anchored-menu pattern as Font
   and Service): Auto pinned at the top with the detected native name, then
   shipped locales by native name. Search matches native name, English name,
   and locale id.
4. Plugin `PluginLocalizedString` still requires `en` and `zh-CN`. Other
   shell locales fall back to English. The changelog follows shipped shell
   locales when a translation exists and falls back to English otherwise;
   its initial `en` / `zh-CN` set is amended by ADR 0182 with `zh-TW`.

## Consequences

- Adding a UI locale is a catalog file, a registry row, an
  `AppSettings.language` union member, and an Electron locale pack. The
  picker does not change.
- Native names stay findable even when the current UI language is unknown
  to the user.
- Plugins and release notes do not have to ship every new shell locale on
  day one.

## Alternatives

- Keep language as wrapping preview cards: unreadable past three or four
  options, and names would still be hard-coded.
- Require plugins to add every shipped locale: breaks existing manifests
  and is out of proportion to a shell translation.
