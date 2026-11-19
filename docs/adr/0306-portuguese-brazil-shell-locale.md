# ADR 0306: Brazilian Portuguese (pt-BR) shell locale

- Status: Accepted
- Date: 2026-09-23
- Related: ADR 0160, ADR 0182, ADR 0183, ADR 0185, D314, D605

## Context

The locale registry supports complete shell catalogs, but Brazilian Portuguese
users were limited to English or another shipped locale, although Portuguese
orthography, grammar, and technical terminology are served by neither an
English fallback nor European Portuguese.

## Decision

Ship a complete Brazilian Portuguese shell catalog at
`packages/i18n/src/locales/pt-BR`, named `Português (Brasil)` /
`Portuguese (Brazil)`. Resolve `pt-BR`, `pt_BR`, and generic `pt` / regional
`pt-*` OS tags to it, add `pt-BR` to persisted `AppSettings.language` and
`pt-BR` / `pt_BR` to the Electron Chromium locale allowlist, and ship a
Brazilian Portuguese changelog catalog with the same version and
highlight-count set as English. Catalog keys, interpolation variables, picker
behavior, and the English fallback for plugin labels stay unchanged, and no
host protocol, storage schema, or IPC version changes.

## Consequences

- Users select `Português (Brasil)` or rely on Auto detection without a
  renderer reload.
- Parity tests cover `pt-BR` alongside the existing locales.
- Regional variants resolve here; `pt-PT` can later ship independently.

## Alternatives

- Register `pt-BR` with an English fallback: rejected, the picker would
  advertise an untranslated shell.
- Add generic `pt` only: rejected, `pt-BR` is the convention users expect.
