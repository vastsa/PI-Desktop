# ADR 0287 — Host-rendered plugin scenic Settings surfaces

- **Status:** Accepted for implementation
- **Date:** 2026-09-17
- **Related:** ADR 0104, ADR 0255

## Context

An Electron `WebContentsView` and a sandboxed iframe each create an independent
compositing surface. Although an extension document can make its own background
transparent, its page canvas remains an opaque rectangle between the root scenic
backdrop and the Settings content.

## Decision

The generic plugin Settings document surface is retired for appearance
extensions. `contributes.scenicThemes` supplies declarative localized card
metadata only.

Card selection is immediate. The bounded 0–20 integer blur control is a local
draft until the user presses Apply; the host then uses the existing typed theme
variable persistence boundary.

## Consequences

- A single root scenic backdrop remains visible through Settings surfaces.
- Host-owned layout, focus, search, narrow-window behavior, drag regions, and
  native controls cannot be changed or intercepted by plugins.
- Plugins cannot contribute Settings HTML, CSS, JavaScript, selectors, DOM, or
  arbitrary actions through this capability.
- This deliberately narrow destination does not replace isolated work-panel
  views or plugin panels.
