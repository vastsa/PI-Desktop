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
under a Chinese one.

## Decision

1. `manifest.i18n` and the same block on a marketplace catalog entry become part
   of the plugin contract, with `name`, `description`, and `safetyNotes`.
2. Every Chinese shell locale reads `zh-CN`; every other locale reads `en`.
3. Resolution happens in the **host**, not the renderer: rows leave the process
3. Resolution happens in the **host**, not the renderer: rows leave the process
   as finished strings, exactly like a plugin view title.
4. The desktop shell pushes the app language down (`plugins.setLocale`) whenever
   it changes and then emits `pluginChanged`, so the surfaces re-read.
5. A malformed block (not an object of locale → object, or a non-string
   `name`/`description`/`safetyNotes`) fails `validateManifest`.

## Consequences

- A translated plugin now reads in the user's language on the Extensions page,
  the plugin launcher, and the marketplace, and its `safetyNotes` — the text
  that explains what an install can touch — reads in that language too.
- Catalog search matches every locale's name and description, so a user who
  types what they saw in one language still finds the entry after switching.
- Plugin authors keep shipping a single-language manifest if they want to: the
  flat fields remain the fallback, and no field of the block is mandatory to
  load.
- The host holds one more piece of state (the display locale).

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
