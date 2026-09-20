# ADR 0287 — Host-rendered plugin scenic Settings surfaces

- **Status:** Accepted for implementation
- **Date:** 2026-09-17
- **Related:** ADR 0104, ADR 0255

## Context

An Electron `WebContentsView` and a sandboxed iframe each create an independent
compositing surface. Although an extension document can make its own background
transparent, its page canvas remains an opaque rectangle between the root scenic
backdrop and the Settings content. Native child surfaces can also intercept the
renderer-drawn Windows/Linux controls.

## Decision

The generic plugin Settings document surface is retired for appearance
extensions. `contributes.scenicThemes` supplies declarative localized card
metadata only. Electron main validates the permissions, same-plugin theme
ownership, declared preview image, and the exact `--nexus-backdrop-blur`
`length` variable. The host React Settings tree renders all controls inside its
existing transparent scenic canvas.

Card selection is immediate. The bounded 0–20 integer blur control is a local
draft until the user presses Apply; the host then uses the existing typed theme
variable persistence boundary. There is no iframe, page protocol, bridge, or
second document canvas.

## Consequences

- A single root scenic backdrop remains visible through Settings surfaces.
- Host-owned layout, focus, search, narrow-window behavior, drag regions, and
  native controls cannot be changed or intercepted by plugins.
- Plugins cannot contribute Settings HTML, CSS, JavaScript, selectors, DOM, or
  arbitrary actions through this capability.
- This deliberately narrow destination does not replace isolated work-panel
  views or plugin panels.
