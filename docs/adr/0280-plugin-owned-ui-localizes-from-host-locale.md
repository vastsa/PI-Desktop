# ADR 0280: Plugin-Owned UI Localizes from the Host Locale

- Status: Accepted
- Date: 2026-09-17
- Related: [ADR 0009](0009-english-first-globalization.md) ·
  [ADR 0082](0082-localized-plugin-panel-chrome.md) ·
  [ADR 0159](0159-plugin-generated-settings-and-local-shortcuts.md) ·
  [ADR 0160](0160-shipped-locale-registry-and-language-picker.md) ·
  [ADR 0267](0267-plugin-labels-follow-the-app-language.md)

## Context

The host resolves only the plugin copy it renders itself: `manifest.i18n` for
identity and inline locale maps on a few chrome labels. Extending that to
generated settings, commands, tools, and themes would grow a second incomplete
i18n system inside the manifest.

## Decision

1. For plugin-owned copy the host publishes the active language and nothing else:
   `pi.app.getLocale()`, `getAppearance().locale`, and `appearance:changed`
   reach open panels and loaded plugin processes.
2. Plugin-owned UI — panels, views, widgets, settings destinations, toasts, and
   runtime command titles — localizes itself from that tag.
3. No further `PluginLocalizedString` maps are added to contribution fields:
   generated `contributes.settings` `title`, `description`, and `enum[].label`
   stay author-language strings, and a plugin needing localized settings ships
   `settingsDestinations`.
4. Host-owned surfaces that render without plugin code keep `manifest.i18n`
   (ADR 0267) and the shipped chrome labels.

## Consequences

- A language switch restyles plugin-owned UI live, without a reload or a registry
  rewrite, and authors need not maintain bilingual maps per setting.

## Alternatives

- Host-resolved locale maps on every contribution field: rejected; two models in
  one manifest, still only `en` and `zh-CN`.
- Resolve plugin copy in the renderer: rejected in ADR 0267; the renderer must
  not parse a manifest.
