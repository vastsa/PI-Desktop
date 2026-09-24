# ADR 0306: Brazilian Portuguese (pt-BR) shell locale

- Status: Accepted
- Date: 2026-09-23
- Decision owners: PI-Desktop desktop/i18n maintainers
- Related: ADR 0160, ADR 0182, ADR 0183, ADR 0185, D314, D605

## Context

The searchable locale registry already supports complete shell catalogs, but
Brazilian Portuguese users were still limited to English or another shipped locale.
Brazilian Portuguese is a major world language with distinct orthography, grammar,
and technical terminology that should not be represented by an English fallback or
by European Portuguese.

## Decision

1. Ship a complete Brazilian Portuguese shell catalog at `packages/i18n/src/locales/pt-BR`,
   with native name `Português (Brasil)` and English name `Portuguese (Brazil)`.
2. Resolve `pt-BR`, `pt_BR`, and generic `pt` / regional `pt-*` OS locale tags to
   the Brazilian Portuguese catalog. Add `pt-BR` to persisted `AppSettings.language`
   and add `pt-BR` and `pt_BR` to the Electron Chromium locale allowlist.
3. Ship a Brazilian Portuguese product changelog catalog with the same stable version
   and highlight-count set as English so release notes follow the active shell
   locale.
4. Preserve the existing English-first catalog contract: identical keys,
   interpolation variables, searchable picker behavior, and English fallback
   for plugin-contributed labels. No host protocol, storage schema, or IPC
   version changes.

## Consequences

- Brazilian Portuguese users can select `Português (Brasil)` or use Auto detection
  without reloading the renderer.
- Catalog, placeholder, and changelog parity tests cover `pt-BR` alongside the existing
  shipped locales.
- Regional Portuguese variants currently resolve to this base catalog; European
  Portuguese (`pt-PT`) can be added later as an independent catalog without breaking
  the picker or storage contract.

## Alternatives

- Register `pt-BR` while falling back to English: rejected because the picker
  would advertise an untranslated shell.
- Add generic `pt` without regional distinction: rejected because `pt-BR` is the
  predominant standard expected by the community and Chromium/Electron conventions.
