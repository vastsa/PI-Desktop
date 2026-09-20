# ADR 0267: Plugin Labels Follow the App Language

- **Status**: Accepted
- **Date**: 2026-09-16
- **Related**: [ADR 0009](0009-english-first-globalization.md) ·
  [ADR 0160](0160-shipped-locale-registry-and-language-picker.md) ·
  [ADR 0182](0182-traditional-chinese-shell-locale.md) ·
  [ADR 0280](0280-plugin-owned-ui-localizes-from-host-locale.md) ·
  [07-plugins/02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md) ·
  [07-plugins/07-plugin-marketplace](../spec/07-plugins/07-plugin-marketplace.md)

## Context

A plugin's display name and description come from its manifest, and a
marketplace card's from its catalog entry. Both are single strings written in
whatever language the author used, so the Extensions page, the plugin launcher,
and the marketplace drew Chinese names under an English shell and English names
under a Chinese one. The plugin repository's own validator had been requiring a
top-level `i18n` block — `{ "en": { name, description, safetyNotes }, "zh-CN": {
… } }` — since its first release, and the catalog ships the same block on every
entry. The desktop shell read none of it: rows rendered `name` and
`description` verbatim, so a plugin translated by its author into the user's
language still arrived in the wrong one.

The shell already has every piece the fix needs: `@pi-desktop/i18n` owns the
shipped locale registry, the app language is resolved in the main process
(`settings.language`, or the OS locale while it is `auto`), and localized
manifest fields (`ui.title`, view titles, command and destination labels) are
already resolved by the host through `resolvePluginLocalizedString` with English
fallback.

## Decision

1. `manifest.i18n` and the same block on a marketplace catalog entry become part
   of the plugin contract, with `name`, `description`, and `safetyNotes`.
   `en` and `zh-CN` are the contract locales; a plugin is not required to
   translate itself into the other shipped shell locales.
2. Every Chinese shell locale reads `zh-CN`; every other locale reads `en`.
   `zh-TW` therefore reads English rather than a half-shared `zh-CN` guess,
   matching `resolvePluginLocalizedString` (ADR 0182).
3. Resolution happens in the **host**, not the renderer: rows leave the process
3. Resolution happens in the **host**, not the renderer: rows leave the process
   as finished strings, exactly like a plugin view title. A missing locale, a
   missing field, or an empty string falls back per field to the other contract
   locale, and from there to the author's flat `name` / `description`, so a
   partial translation never blanks a row.
4. The desktop shell pushes the app language down (`plugins.setLocale`) whenever
   it changes and then emits `pluginChanged`, so the surfaces re-read. The
   registry keeps the author's own strings: a language change never rewrites
   persisted rows, and the `i18n` block is neither persisted nor sent over RPC.
5. A malformed block (not an object of locale → object, or a non-string
   `name`/`description`/`safetyNotes`) fails `validateManifest`. Unknown locales
   and unknown fields inside an entry are ignored, so a publisher may carry more
   than the contract requires.

## Consequences

- A translated plugin now reads in the user's language on the Extensions page,
  the plugin launcher, and the marketplace, and its `safetyNotes` — the text
  that explains what an install can touch — reads in that language too.
- Catalog search matches every locale's name and description, so a user who
  types what they saw in one language still finds the entry after switching.
- Plugin authors keep shipping a single-language manifest if they want to: the
  flat fields remain the fallback, and no field of the block is mandatory to
  load.
- The host holds one more piece of state (the display locale). It is pushed by
  the shell rather than read per request, so a row does not depend on which RPC
  happens to carry a locale.

## Alternatives

- **Resolve in the renderer**: the renderer knows `i18n.language` and would
  switch instantly, but it would have to receive every manifest's `i18n` block,
  which contradicts the rule that the renderer never reads a manifest, and it
  would duplicate the fallback rules the host already owns.
- **Per-request locale parameter on every plugin RPC**: works for `plugins.list`
  but leaves the summaries the host itself returns (install results, permission
  changes, marketplace update checks) unlocalized, and adds a locale to every
  call site.
- **Leave names to the author's language**: the plugin repository already
  requires the block, so the shell would keep ignoring data its ecosystem
  publishes — the reported bug.
