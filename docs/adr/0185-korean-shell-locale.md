# ADR 0185: Korean shell locale

- Status: Accepted
- Date: 2026-09-09
- Related: ADR 0160, ADR 0182, ADR 0183, D349

## Context

The searchable locale registry already supported complete shell catalogs, but
Korean users were limited to English or another shipped locale. Korean is a
distinct language and must not be served by a fallback catalog.

## Decision

Ship a complete Korean shell catalog in the shared i18n package, named `한국어` /
`Korean`, and resolve `ko` and regional `ko-*` OS tags to it, including
`AppSettings.language` and the Electron Chromium locale allowlist. A Korean
product changelog catalog mirrors English versions and highlight counts. The
existing English-first contract holds: identical keys, interpolation variables,
searchable picker behavior, English fallback for plugin labels, and no host
protocol, storage schema, or IPC version change.

## Consequences

- Korean is selectable and auto-detected without reloading the renderer.
- Catalog and changelog parity tests cover Korean like other shipped locales.
- Regional variants share one base catalog; spelling variants can be added later
  without changing the picker contract.

## Alternatives

- Register `ko` with an English fallback: rejected because the picker would
  advertise an untranslated shell.
