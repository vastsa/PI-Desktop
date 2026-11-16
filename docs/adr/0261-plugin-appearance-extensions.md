# ADR 0261: Plugin Appearance Extensions

## Status

Accepted for implementation.

## Context

Plugins can contribute static sanitized themes, but cannot safely vary a
declared theme at runtime or offer a dedicated configuration surface. Letting
plugin code inject CSS, renderer DOM, or arbitrary Settings routes would widen
its authority and break host ownership of navigation and native window chrome.

## Decision

1. `ui.settings` is an independent permission.
2. The host renders contributed items only in the **Extensions** group after all
   core Settings groups.
3. The host renders every scenic Settings DOM node in its normal React tree.
4. `pi.themes.setVariables(themeId, values)` requires `ui.theme`.
5. The host persists accepted values in plugin-private settings and serializes a
   separate host-generated variable rule after static sanitized theme CSS.
6. Disable, uninstall, crash and reload remove every owned destination.

## Consequences

Theme packs can provide bounded controls such as a backdrop blur number without
re-injecting stylesheet text.
