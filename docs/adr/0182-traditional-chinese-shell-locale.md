# ADR 0182: Traditional Chinese shell locale

- Status: Accepted
- Date: 2026-09-08
- Decision owners: PI-Desktop desktop/i18n maintainers
- Related: ADR 0160, D314, E2E-091

## Context

The locale registry already made the language picker extensible, but every
Traditional Chinese OS tag still resolved to the Simplified Chinese catalog.
That made Auto selection incorrect for Traditional Chinese users and left
the shell and in-app release notes with Simplified Chinese terminology.

## Decision

1. Ship `zh-TW` as an independent full shell catalog with the native name
   `繁體中文`, including the host-owned plugin-panel chrome. The searchable
   language picker continues to read the shared locale registry and therefore
   needs no locale-specific UI code.
2. Resolve `zh-TW`, `zh-Hant`, `zh-HK`, and `zh-MO` tags to `zh-TW`, including
   underscore-separated forms. Generic `zh` and Simplified Chinese regions
   continue to resolve to `zh-CN`.
3. Add `zh-TW` to `AppSettings.language` and package both `zh-TW` and
   `zh_TW` Electron locale directories. No host protocol or storage schema
   version changes.
4. Add a matching `zh-TW` product changelog catalog and resolve Traditional
   Chinese release-note requests to it. Plugin manifests keep their existing
   `en` + `zh-CN` contract; a plugin without a Traditional Chinese field
   falls back to English, as specified by ADR 0160.

## Consequences

- Traditional Chinese users get an independent shell, correct Auto detection,
  searchable language selection, locale-aware date formatting, and
  Traditional Chinese release notes.
- The i18n and changelog catalog parity tests cover one additional shipped
  locale.
- New shell locales still follow ADR 0160: add a catalog, registry row,
  settings union member, Electron locale pack, and relevant validation.

## Alternatives

- Continue mapping Traditional Chinese tags to `zh-CN`: rejected because the
  script and common UI terminology are different.
- Add only `zh-TW` while leaving release notes on `zh-CN`: rejected because
  the update surface is part of the active product shell.
