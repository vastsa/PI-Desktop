# ADR 0032: Reserve native width for the docked work panel

- Status: Accepted (amended by ADR 0033 and ADR 0122)
- Date: 2026-07-29
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D163
- Supersedes in part: ADR 0029 and decision D156

## Context

ADR 0029 removed a circular ownership model in which work-panel changes and
native resize events rewrote each other. It made the panel a responsive column
inside the existing client area.

## Decision

Renderer panel layout and Electron window geometry remain separate owners, but
they coordinate through an idempotent target-state reservation:

1. The renderer owns one committed preferred panel width in the inclusive
   `364..720` range.
2. The preload exposes only `window/setWorkPanelReservation({ width: 0 |
   364..720 })`.
3. In normal window state, Main derives visible bounds from persisted base
   bounds plus the target reservation.
4. Opening the visible panel requests its committed width.
5. When the work area can supply the complete target, panel visibility and
   divider commits do not change chat width.
6. While a reservation is active, native edge resizing changes base window
   bounds and therefore chat width only.
7. Maximized and fullscreen windows record the latest requested target but defer
   reservation geometry.
8. Moving the window to another display or changing display work-area geometry
   reconciles the same target against the new available width.
9. Persisted normal bounds are base bounds with the active reservation width and
   reservation-induced x shift removed.
10. Only the currently visible session context may set the reservation.

The divider's anchored pointer math, frame-coalesced preview, commit-on-release,
and cancellation rollback from ADR 0029 remain in force. Live preview remains a
renderer layout operation; only a successful commit changes the native target.

## Consequences

- Opening and collapsing a panel preserve the conversation width whenever the
  display work area has enough unused width.
- Native edge gestures have one predictable effect: they resize the conversation
  while the panel remains fixed.
- Small displays can make chat narrower than its 360px readability target, but
  never silently compress the panel or corrupt its committed preference.
- Main owns a narrow, allowlisted geometry capability rather than an arbitrary
  delta resize channel.
- Window-state persistence and maximize/fullscreen transitions must distinguish
  base bounds from temporary reservation geometry.

## Alternatives

### Keep all columns inside the current client area

Rejected because panel open/collapse would continue to resize the conversation,
and native edge gestures could continue to compress the panel.

### Restore renderer-supplied resize deltas

Rejected because deltas are not idempotent and recreate the stale-request,
double-resize, and persistence ambiguity removed by ADR 0029.

### Force the full reservation outside the display work area

Rejected because a fixed panel must not move native chrome off screen.

## References

- `docs/adr/0029-separate-window-and-panel-resize-ownership.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-056)
- `docs/spec/08-meta/decisions-log.md` (D163)
