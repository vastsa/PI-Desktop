# ADR 0132: Attribute cross-display window moves to the user

- Status: Accepted (amends ADR 0122 and the ADR 0032 reservation behavior it restored)
- Date: 2026-08-28
- Related: D263, ADR 0032, ADR 0122, issue #18

## Context

ADR 0122 keeps a display-aware native reservation for the docked work panel,
planned from remembered base bounds and reconciled against the last applied rect,
but its single `displayChanged` boolean collapsed two opposite situations. Reusing
remembered base bounds is right when the OS re-fitted bounds we asked for and wrong
when the user dragged the window there, so a drag to a second display jumped on
pointer release and the misattribution leaked into `window-state.json`, reopening on
the display the user had left (issue #18).

## Decision

Replace the `displayChanged` boolean with an explicit `DisplayTransition` of `none`,
`os-adjusted`, or `user-moved`, where `os-adjusted` keeps ADR 0122's behavior so
remembered base bounds survive an OS re-fit or topology change, and `user-moved`
derives new base bounds from the current position so the drop position becomes the
intent, normalizing only the origin into the target work area and preserving size
even when that work area is smaller. A transition counts as `user-moved` when an
unaccounted native `move` stream precedes it: the marker is a flag rather than a
deadline, so attribution never depends on main-process scheduling, and the `move`
handler never re-plans mid-drag but defers reconciliation until the stream goes
quiet. Base bounds persist for `none` and `user-moved` with the remembered display
key advanced on `user-moved`, `os-adjusted` still refuses to persist, an unconsumed
marker retires on a deadline that only bounds lingering, and a forced bounds
recovery clears the pending attribution because it is not user intent.

## Consequences

- Dragging between displays keeps the drop position with no jump, and relaunch
  reopens on the display the window was last used on.
- Topology events clear the marker first, so ADR 0122's constrained-display
  behavior is preserved for OS-owned adjustments.
- A window dropped onto a smaller display keeps its size, pinned to the work area's
  top-left, while `planWorkPanelReservation` shrinks the reservation; no IPC,
  storage, or host protocol change, and `window/setWorkPanelReservation` keeps its
  request and response shape.

## Alternatives

- Clamp remembered base bounds into the new display: keeps the window on the target
  display but discards the drop position.
- Attribute the drag with a time deadline: correctness would depend on main-process
  scheduling.
