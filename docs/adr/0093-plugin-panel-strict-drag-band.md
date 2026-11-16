# ADR 0093: Keep a strict 46px plugin drag band with a minimal capsule

- Status: Accepted
- Date: 2026-08-17
- Related: D235, ADR 0092

## Context

Frameless plugin panels need a reliable drag area, so the top band cannot receive
plugin clicks. The host must not grow that band for a title, a platform-specific
control row, or decorative chrome, and development authors need a visible
reminder of the constraint.

## Decision

1. Every panel reserves exactly 46 CSS px for the transparent host drag band;
   normal-flow content is offset by that value and fixed or sticky plugin UI uses
   `--pi-plugin-titlebar-height: 46px`.
2. The band uses `-webkit-app-region: drag` and blocks plugin pointer interaction;
   the host capsule opts out with `no-drag` so its three buttons stay clickable.
3. The host renders no panel title; development panels show a localized,
   non-interactive reminder that the top band is drag-only outside the capsule.
4. The capsule stays fixed at the top-right inside the band as a minimal closed
   Shadow-DOM surface; its sender-validated window-control channel, localized
   labels, focus, reduced-motion behavior, and `window.pluginBridge` are unchanged.
5. Panels needing a full-bleed surface declare
   `<meta name="pi-plugin-chrome" content="v3">`: the host keeps the geometry and
   capsule but swaps one full-width native drag rectangle for empty-space drag
   segments, so elements marked `data-pi-plugin-no-drag` paint and receive pointer
   events while blank space still drags; `v2` panels keep the strict band.

## Consequences

- Authors get a stable layout and interaction contract on every platform.
- Development panels show the constraint while production panels stay quiet, and
  the capsule cannot extend beyond the drag band.

## Alternatives

- Let the band grow with the capsule: the same panel would differ across
  platforms and chrome revisions.
- Give plugin content clicks by default: frameless dragging would become
  unreliable.
