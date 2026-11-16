# ADR 0183: P0 international shell locales

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0160, ADR 0182, D346, E2E-091

## Context

The locale registry accepts new languages without picker work, but the shipped
shell stopped at English, Simplified Chinese, Traditional Chinese, and Turkish,
leaving Spanish, French, and German out of the UI catalog and the release notes.

## Decision

Ship complete shell catalogs for `de`, `es`, and `fr` with English as the source
and full key and interpolation parity, registered as `Deutsch`, `Español`, and
`Français` in the shared locale registry. `de-*`, `es-*`, and `fr-*` OS tags
resolve to those base catalogs, `AppSettings.language` accepts the three ids, and
matching changelog catalogs ship with them.

## Consequences

- Users select the languages without a reload and see localized release notes.
- Parity tests cover shell strings, both interpolation styles, and release-note
  parity, and regional variants share one base catalog.

## Alternatives

- Add registry rows only: rejected; it advertises untranslated languages.
- Add region-specific catalogs now: rejected; P0 wants one catalog per language.
