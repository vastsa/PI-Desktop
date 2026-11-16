# ADR 0132: Attribute cross-display window moves to the user

- Status: Accepted
- Date: 2026-08-28
- Related: [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  decision D263 · issue #18
- Amends: ADR 0122 (and the reservation behavior it restored from ADR 0032)

## Context

ADR 0122 keeps a target-state, display-aware native reservation for the docked
work panel. Main plans the reservation from remembered *base bounds* — the
window rect without the reservation — and reconciles later native deltas against
the last rect it actually applied.

## Decision

1. Replace the `displayChanged` boolean with an explicit `DisplayTransition` of
   `none`, `os-adjusted`, or `user-moved`.
2. `os-adjusted` keeps ADR 0122's behavior unchanged: the remembered base bounds
   survive an OS re-fit or a display topology change.
3. `user-moved` derives new base bounds from the window's current position, so
   the drop position becomes the intent.
4. Classify the transition by whether an unaccounted native `move` stream
   precedes it.
5. Never re-plan bounds mid-drag.
6. Persist base bounds for both `none` and `user-moved`, and advance the
   remembered display key on `user-moved`, so relaunch restores the display the
   user actually left the window on.
7. Retire an unconsumed marker on a deadline.
8. A forced bounds recovery (the Stage Manager path) clears the pending
   user-move attribution, because it is not user intent.

## Consequences

- Dragging the window between displays keeps the position where it was dropped,
  with no jump on pointer release.
- Relaunch reopens the window on the display it was last used on.
- ADR 0122's constrained-display reservation behavior is preserved verbatim for
  OS-owned adjustments, including the restore path back to a roomy display.
- Display topology events clear the pending marker before reconciling, so a
  display added, removed, or rescaled right after a drag is still classified as
  OS-owned.
- A window dropped onto a display whose work area cannot hold it keeps its size
  and is pinned to the work area's top-left.

## Alternatives

### Clamp the remembered base bounds into the new display

Rejected. It keeps the window on the target display but discards the drop
position, which is the reported symptom rather than a fix for it.

### Skip reservation planning entirely on a display change

Rejected. The reservation would then be sized for the previous display's work
area, so a narrower target display would leave the window wider than its work
area.

### Detect drags from pointer state instead of the move stream

Rejected for now. Electron exposes no drag-begin/drag-end pair for native window
moves, and polling the pointer during a drag costs more than the pending-move
marker it would replace.

### Attribute the drag with a time deadline

Rejected. A deadline makes correctness depend on main-process scheduling: a busy
main process, or a maximized window that defers its geometry past the deadline,
would silently fall back to the buggy OS-adjusted path.

## References

- `apps/desktop/electron/main/work-panel-window.ts`
- `apps/desktop/electron/main/index.ts`
- `apps/desktop/test/work-panel-window.test.mjs`
- `docs/adr/0122-reserve-native-width-while-work-panel-visible.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-160)
- `docs/spec/08-meta/decisions-log.md` (D263)
