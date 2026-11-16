# ADR 0182: Traditional Chinese shell locale

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0160, D314, E2E-091

## Context

The locale registry made the language picker extensible, but every Traditional
Chinese OS tag still resolved to the Simplified catalog, so Auto selection was
wrong for those users.

## Decision

Ship `zh-TW` as an independent full shell catalog named `繁體中文`, resolving
`zh-TW`, `zh-Hant`, `zh-HK`, and `zh-MO` (including underscore forms) to it while
generic `zh` and Simplified regions stay on `zh-CN`. Add `zh-TW` to
`AppSettings.language`, package the `zh-TW` and `zh_TW` Electron locale
directories, and add a matching changelog catalog, with no host protocol or
storage schema change; plugin manifests keep their `en` + `zh-CN` contract per
ADR 0160.

## Consequences

- Traditional Chinese users get an independent shell, correct Auto detection,
  and Traditional Chinese release notes.
- Catalog parity tests cover one additional shipped locale, and new locales
  still follow ADR 0160's registry steps.

## Alternatives

- Map Traditional Chinese tags to `zh-CN`: rejected, the script and terminology
  differ.
