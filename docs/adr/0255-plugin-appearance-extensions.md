# 0255 — Plugin Appearance Extensions

## Status

Accepted for implementation.

## Context

Plugins can contribute static sanitized themes, but cannot safely vary a declared theme at runtime or offer a dedicated configuration surface. Letting plugin code inject CSS, renderer DOM, or arbitrary Settings routes would widen its authority and break host ownership of navigation and native window chrome.

## Decision

1. `ui.settings` is an independent permission. Only a loaded plugin holding it and declaring an existing HTML entry contributes a Settings item.
2. The host renders contributed items only in the **Extensions** group after all core Settings groups. Core ordering, search shell, titlebar and fallback navigation remain host-owned.
3. A Settings entry is hosted in the same isolated per-plugin `WebContentsView` model as a plugin work-panel view: sandboxed preload, context isolation, disabled Node integration, partitioned session and manifest egress policy. The renderer supplies only a measured content rectangle.
4. `pi.themes.setVariables(themeId, values)` requires `ui.theme`. It accepts values only for the caller's declared theme variables. The manifest declares one of `length` (`px`), finite `number`, strict hex `color`, or a fixed `select` value. The host rejects host-reserved names, undeclared keys, unsafe CSS fragments and cross-plugin ids.
5. The host persists accepted values in plugin-private settings and serializes a separate host-generated variable rule after static sanitized theme CSS. Static `plugin-asset://` references remain valid; no runtime stylesheet, image, font, layout, filesystem or network authority is granted.
6. Disable, uninstall, crash and reload remove every owned Settings view. If an active destination disappears, the renderer returns to General.

## Consequences

Theme packs can provide bounded controls such as a backdrop blur number without re-injecting stylesheet text. Settings extensions retain the existing plugin sandbox and lifecycle boundaries.
