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

On Windows, the open work-panel header placed the active resource close button
beside the viewport-fixed panel toggle and the native minimize/maximize/close
cluster. At narrow widths, the two close icons read as a duplicate top-right
action and the header became difficult to scan.

## Decision

1. The open work-panel header exposes one compact resource switcher. Closing a
   resource is owned by its existing unified context-menu row, which keeps the
   close action next to the resource it affects without adding another `X` to
   the window chrome.
2. The viewport-fixed work-panel toggle remains the sole panel-level collapse
   control. Windows/Linux native window controls remain in their fixed right
   edge band.
3. Subagent detail uses a back chevron to return to the resource list, so its
   navigation action is visually distinct from both resource close and native
   window close.
4. The change is renderer presentation and interaction only. It does not alter
   panel state ownership, resource lifecycle, window geometry, IPC, protocol,
   or storage.

## Consequences

- The Windows top-right row has one clear window-close action and a separated
  panel toggle.
- Resource close remains available from the keyboard-operable unified menu and
  can no longer be mistaken for closing the application.
- The header gives up one direct-click close affordance in exchange for a
  stable, less crowded action cluster.

## Alternatives considered

- **Keep the header resource `X` and shrink the native controls:** rejected;
  native window affordances must keep their platform-sized hit targets.
- **Add another panel-specific close or collapse icon:** rejected; D357 and
  ADR 0195 make the viewport-fixed toggle the sole panel-level collapse
  control.
