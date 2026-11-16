# ADR 0267: Plugin Labels Follow the App Language

- Status: Accepted
- Date: 2026-09-16
- Related: [ADR 0009](0009-english-first-globalization.md) ·
  [ADR 0160](0160-shipped-locale-registry-and-language-picker.md) ·
  [ADR 0182](0182-traditional-chinese-shell-locale.md) ·
  [ADR 0280](0280-plugin-owned-ui-localizes-from-host-locale.md) ·
  [07-plugins/02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md)

## Context

A plugin's display name and description come from its manifest, and a marketplace
card's from its catalog entry, both as single strings in whatever language the author
used, so the Extensions page, launcher, and marketplace showed Chinese names under an
English shell and English names under a Chinese one. The plugin repository's validator
had required a top-level `i18n` block with `name`, `description`, and `safetyNotes` per
locale since its first release, but the desktop shell read none of it.

## Decision

1. `manifest.i18n` and the same block on a catalog entry become part of the plugin
   contract; `en` and `zh-CN` are the contract locales, and a plugin need not translate
   itself into every shipped shell locale.
2. Every Chinese shell locale reads `zh-CN` and every other locale reads `en`, so
   `zh-TW` reads English rather than a half-shared `zh-CN` guess (ADR 0182).
3. Resolution happens in the host, not the renderer: rows leave the process as
   finished strings, and a missing locale, field, or empty string falls back per field
   to the other contract locale and then to the author's flat `name` / `description`.
4. The shell pushes the language down through `plugins.setLocale` on change and emits
   `pluginChanged`, so persisted rows are never rewritten and the `i18n` block is
   neither persisted nor sent over RPC.
5. A malformed block fails `validateManifest`, while unknown locales and unknown fields
   are ignored so a publisher may carry more than the contract requires.

## Consequences

- A translated plugin reads in the user's language on the Extensions page, launcher,
  and marketplace, `safetyNotes` included.
- Catalog search matches every locale's name and description.
- Authors may keep shipping a single-language manifest, because the flat fields remain
  the fallback and no field of the block is mandatory to load.

## Alternatives

- Resolve in the renderer — rejected: it would receive every manifest's `i18n` block
  and duplicate fallback rules the host owns.
