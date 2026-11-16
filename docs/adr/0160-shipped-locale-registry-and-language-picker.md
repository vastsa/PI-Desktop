# ADR 0160: Shipped locale registry and searchable language picker

- Status: Accepted (amended by ADR 0182)
- Date: 2026-09-05
- Decision owners: PI-Desktop desktop/i18n maintainers
- Related: D012, D073, ADR 0009

## Context

The General appearance card presented language as three preview cards (Auto /
简体中文 / English). That control does not scale: every new locale needed a
hard-coded card, sample glyph, and catalog keys for its name.

## Decision

1. `@pi-desktop/i18n` owns a `supportedLocales` registry: id, native name
   (endonym, never translated), and English name.
2. `AppSettings.language` is `"auto"` plus every registry id.
3. Settings → General → Appearance keeps Theme as three preview cards.
4. Plugin `PluginLocalizedString` still requires `en` and `zh-CN`.

## Consequences

- Adding a UI locale is a catalog file, a registry row, an
  `AppSettings.language` union member, and an Electron locale pack.
- Native names stay findable even when the current UI language is unknown to the
  user.
- Plugins and release notes do not have to ship every new shell locale on day
  one.

## Alternatives

- Keep language as wrapping preview cards: unreadable past three or four
  options, and names would still be hard-coded.
- Require plugins to add every shipped locale: breaks existing manifests and is
  out of proportion to a shell translation.
