# ADR 0183: P0 international shell locales

- Status: Accepted
- Date: 2026-09-08
- Decision owners: PI-Desktop desktop/i18n maintainers
- Related: ADR 0160, ADR 0182, D346, E2E-091

## Context

The locale registry could add languages without renderer-specific picker work,
but the shipped shell stopped at English, Simplified Chinese, Traditional
Chinese, and Turkish. Spanish, French, and German are high-value international
locales for the desktop product and were missing from the UI catalog and
in-app release notes.

## Decision

1. Ship complete shell catalogs for `de`, `es`, and `fr`, keeping English as
   the source catalog and preserving key and interpolation parity.
2. Register native names `Deutsch`, `Español`, and `Français`; the searchable
   picker continues to derive its options from the shared locale registry.
3. Resolve `de-*`, `es-*`, and `fr-*` OS locale tags to their shipped base
   catalogs. Persisted `AppSettings.language` accepts the three new ids.
4. Ship matching product changelog catalogs so release notes follow the active
   locale. No host protocol, storage schema, or Electron IPC version changes.

## Consequences

- Users can select German, Spanish, or French without a renderer reload.
- Locale parity tests cover shell strings, both interpolation styles, and
  release-note version/highlight parity.
- Regional variants intentionally share one base catalog; region-specific
  spelling can be added later without changing the picker contract.

## Alternatives

- Add only registry rows and fall back to English: rejected because it would
  advertise languages without localizing the shell.
- Add region-specific catalogs immediately: rejected because the P0 goal is
  broad coverage with one maintainable catalog per language.
