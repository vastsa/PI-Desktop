# ADR 0093: Keep a strict 46px plugin drag band with a minimal capsule

- Status: Accepted
- Date: 2026-08-17
- Deciders: PI-Desktop core
- Related: D235, ADR 0092

## Context

The plugin-owned panel surface introduced a compact host capsule, but its layout
contract must remain explicit. Frameless windows still need a reliable drag
area, and the top band cannot receive plugin clicks.

## Decision

1. Every plugin panel reserves exactly 46 CSS px for the transparent host drag
   band.
2. The drag band uses `-webkit-app-region: drag` and blocks plugin pointer
   interaction across those 46px.
3. The host renders no panel title.
4. The capsule stays fixed at the top-right inside the 46px band and remains a
   minimal closed-Shadow-DOM surface: three controls, a subtle border and
   page-adaptive background, with no heavy shadow or blur effect.

## Paint-through opt-in

Panels that need a full-bleed surface may declare `<meta name="pi-plugin-chrome"
content="v3">`. The host keeps the same 46px geometry and capsule, but replaces
one full-width native drag rectangle with empty-space drag segments.

## Consequences

- Plugin authors get a stable 46px layout and interaction contract on every
  desktop platform.
- The top band is intentionally unavailable to plugin buttons except for the
  host capsule; plugin toolbars should use the documented drag/no-drag rules.
- Development authors see the constraint while production panels keep the
  surface quiet.
- The capsule has less visual weight and cannot extend beyond the drag band.

## Alternatives

### Let the drag band grow with the capsule

Rejected because a variable host band would change plugin layout and make the
same panel differ across platforms or future chrome revisions.

### Let every plugin content receive clicks in the drag band by default

Rejected for the default because frameless window dragging would become
unreliable and authors could mistake the top strip for ordinary interactive
content.

### Restore a host-rendered panel title

Rejected because the plugin owns the visible panel hierarchy; the host only
needs the three native window actions and the development constraint reminder.
