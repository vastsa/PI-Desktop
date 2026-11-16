# ADR 0287 — Host-rendered plugin scenic Settings surfaces

- **Status:** Accepted for implementation
- **Date:** 2026-09-17
- **Related:** ADR 0104, ADR 0255

## Context

An Electron `WebContentsView` and a sandboxed iframe each composite their own
surface, so an extension document with a transparent background still paints an
opaque rectangle between the root scenic backdrop and the Settings content, and
native child surfaces can intercept the renderer-drawn Windows and Linux controls.

## Decision

The generic plugin Settings document surface is retired for appearance extensions:
`contributes.scenicThemes` supplies declarative localized card metadata only, and
Electron main validates the permissions, same-plugin theme ownership, declared
preview image, and the exact `--nexus-backdrop-blur` `length` variable. The host
React tree renders every control inside its existing transparent scenic canvas,
card selection is immediate, and the bounded blur control stays a draft until
Apply. There is no iframe, page protocol, bridge, or second canvas.

## Consequences

- One root scenic backdrop stays visible through Settings surfaces.
- Host-owned layout, focus, search, drag regions, and native controls cannot be
  changed or intercepted, and plugins contribute no Settings HTML, CSS, or actions.
