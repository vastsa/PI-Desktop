# ADR 0261: Plugin Appearance Extensions

## Status

Accepted for implementation.

## Context

Plugins can contribute static sanitized themes but cannot safely vary a declared
theme at runtime or offer their own configuration surface, and letting plugin code
inject CSS, renderer DOM, or arbitrary Settings routes would break host ownership of
navigation and native window chrome.

## Decision

`ui.settings` is an independent permission: a loaded plugin holding it and
`ui.theme` may contribute one validated, data-only scenic destination, which the
host renders in the **Extensions** group after the core Settings groups while
keeping ordering, the search shell, titlebar, and fallback navigation. Every scenic
node is rendered by the host in its normal React tree, so plugins contribute no
entry document, DOM, styles, scripts, or actions.
`pi.themes.setVariables(themeId, values)` requires `ui.theme` and accepts values
only for the caller's declared variables, typed as `length`, finite `number`, strict
hex `color`, or fixed `select`, rejecting host-reserved names, undeclared keys,
unsafe CSS fragments, and cross-plugin ids. Accepted values persist in
plugin-private settings, and disable, uninstall, crash, or reload removes every
owned destination.

## Consequences

- Theme packs can offer bounded controls such as a backdrop blur number without
  re-injecting stylesheet text.
- Settings extensions keep the existing plugin sandbox and lifecycle boundaries.
