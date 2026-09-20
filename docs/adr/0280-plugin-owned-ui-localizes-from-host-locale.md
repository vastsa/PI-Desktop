# ADR 0280: Plugin-Owned UI Localizes from the Host Locale

- **Status**: Accepted
- **Date**: 2026-09-17
- **Related**: [ADR 0009](0009-english-first-globalization.md) ·
  [ADR 0082](0082-localized-plugin-panel-chrome.md) ·
  [ADR 0159](0159-plugin-generated-settings-and-local-shortcuts.md) ·
  [ADR 0160](0160-shipped-locale-registry-and-language-picker.md) ·
  [ADR 0267](0267-plugin-labels-follow-the-app-language.md) ·
  [07-plugins/02-plugin-manifest-schema](../spec/07-plugins/02-plugin-manifest-schema.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

The host already resolves two kinds of plugin copy it renders itself:
`manifest.i18n` for identity (`name` / `description` / `safetyNotes`), and
inline `{ en, "zh-CN" }` on a few chrome labels (`ui.title`, view titles,
settings destinations, session sources). Putting the same maps on generated
`contributes.settings` (and then on commands, tools, themes) would grow a
second incomplete i18n system inside the manifest: only two contract locales,
two declaration shapes, and still no way for a panel or widget to relabel its
own HTML.

A plugin process can already read the app language (`pi.app.getLocale`,
`pi.app.getAppearance().locale`). Open panels already receive
`appearance:changed`. The plugin process did not.

## Decision

1. For **plugin-owned** copy the host publishes the active language and
   nothing else: `pi.app.getLocale()`, `getAppearance().locale`, and
   `appearance:changed` to open panels **and** loaded plugin processes.
2. Plugin-owned UI (panels, views, widgets, settings destinations, toasts,
   runtime command titles) localizes itself from that tag. Authors pick any
   catalog they want; the host does not translate it.
3. Do not add more `PluginLocalizedString` maps to contribution fields.
   Generated `contributes.settings` `title` / `description` / `enum[].label`
   stay author-language plain strings. A plugin that needs a localized
   settings surface ships `settingsDestinations`.
4. Host-owned surfaces that render without plugin code keep the contracts
   they already have: `manifest.i18n` (ADR 0267) and the shipped chrome
   labels in (2) of the Context.

## Consequences

- A language switch restyles plugin-owned UI live, without a reload and
  without rewriting the registry.
- Authors are not required to maintain bilingual maps for every setting.
- Existing host chrome localization is unchanged.

## Alternatives

- **Host-resolved locale maps on every contribution field**: two models in
  one manifest, still only `en` / `zh-CN`, and plugin HTML remains unsolved.
- **Resolve plugin copy in the renderer**: rejected in ADR 0267; the
  renderer still must not parse a manifest.
