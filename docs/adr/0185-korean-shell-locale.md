# ADR 0185: Korean shell locale

- Status: Accepted
- Date: 2026-09-09
- Decision owners: PI-Desktop desktop/i18n maintainers
- Related: ADR 0160, ADR 0182, ADR 0183, D349, E2E-091

## Context

The searchable locale registry already supports complete shell catalogs, but
Korean users were still limited to English or another shipped locale. Korean
is a distinct language and should not be represented by an English fallback or
by a Chinese catalog with a Korean label.

## Decision

1. Ship a complete Korean shell catalog at `packages/i18n/src/locales/ko`,
   with native name `한국어` and English name `Korean`.
2. Resolve `ko` and regional `ko-*` OS locale tags to the Korean catalog. Add
   `ko` to persisted `AppSettings.language` and to the Electron Chromium
   locale allowlist.
3. Ship a Korean product changelog catalog with the same stable version and
   highlight-count set as English so release notes follow the active shell
   locale.
4. Preserve the existing English-first catalog contract: identical keys,
   interpolation variables, searchable picker behavior, and English fallback
   for plugin-contributed labels. No host protocol, storage schema, or IPC
   version changes.

## Consequences

- Korean users can select Korean or use Auto detection without reloading the
  renderer.
- Catalog and changelog parity tests cover Korean alongside the existing
  shipped locales.
- Regional Korean variants intentionally share one base catalog; spelling
  differences can be added later without changing the picker contract.

## Alternatives

- Register `ko` while falling back to English: rejected because the picker
  would advertise an untranslated shell.
- Add region-specific Korean catalogs immediately: rejected because the
  current locale contract uses one maintainable catalog per language.
