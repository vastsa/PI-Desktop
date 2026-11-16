# ADR 0220: Keep Windows Work-Panel Chrome Single-Purpose

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop desktop UI maintainers
- Amends: D154, D357, ADR 0195
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [07-ui-design-system](../spec/04-ux/07-ui-design-system.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-067

## Context

On Windows the open work-panel header put the active resource close button beside the
viewport-fixed toggle and the native window cluster, so at narrow widths two close
icons read as one duplicated top-right action.

## Decision

The header exposes one compact resource switcher, and closing a resource is owned by
its existing unified context-menu row. The viewport-fixed toggle stays the sole
panel-level collapse control, Windows/Linux window controls stay in their fixed right
edge band, and subagent detail uses a back chevron. This is renderer presentation
only: panel state ownership, resource lifecycle, window geometry, IPC, protocol, and
storage are unchanged.

## Consequences

The Windows top-right row has one window-close action and a separated toggle, so
resource close can no longer be mistaken for closing the application, at the cost of
one direct-click close affordance.

## Alternatives

- Keep the header `X` and shrink native controls: platform hit targets must keep
  their size.
- Add another close icon: D357 and ADR 0195 make the viewport-fixed toggle the only
  panel-level collapse control.
