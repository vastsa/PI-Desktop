# ADR 0082: Localized and page-adaptive plugin panel chrome

## Status

Accepted

## Context

Plugin panels are hosted in their own Electron windows. Their titlebar was given
a single string from the manifest and the preload chrome defaulted to a dark
surface.

## Decision

1. `ui.title` accepts either the existing string form or a localized object
   containing both `en` and `zh-CN` strings.
2. The host passes the active light/dark theme to the panel window.
3. The titlebar remains in the closed preload-owned Shadow DOM.
4. Existing string manifests and existing panel dimensions remain compatible.

## Consequences

- Plugin authors can ship one manifest with English and Simplified Chinese panel
  titles.
- Panel chrome remains visually coherent with custom plugin pages and the host's
  explicit theme preference.
- A panel whose colors change after first paint is not continuously inspected;
  plugins should set their page surface before `DOMContentLoaded`.
