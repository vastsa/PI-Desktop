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
window rect without the reservation — and reconciles later native deltas
against the last rect it actually applied.

That reconciliation collapsed two very different situations into one
`displayChanged` boolean. When the window ended up on another display, the
remembered base bounds were reused verbatim, then clamped into the new
display's work area. That is correct when the OS re-fitted bounds we asked for:
the user's intent survives on a constrained display and is restored on a roomy
one. It is wrong when the user dragged the window there, because the previous
display's coordinates are no longer the intent.

Worse, the reconcile was wired to every native `move` event, so it ran while
the drag was still in progress. Reported in issue #18 and reproducible on every
release from 0.10.0 onward: dragging the window to a second display made it jump
on pointer release, because the deferred `setBounds` planned from the origin
display's base bounds and landed at the target display's clamped edge. The
window's y coordinate came from the old display too. The same misattribution
then leaked into `window-state.json`, so relaunch reopened the window on the
display the user had left.

## Decision

1. Replace the `displayChanged` boolean with an explicit `DisplayTransition` of
   `none`, `os-adjusted`, or `user-moved`.
2. `os-adjusted` keeps ADR 0122's behavior unchanged: the remembered base
   bounds survive an OS re-fit or a display topology change.
3. `user-moved` derives new base bounds from the window's current position, so
   the drop position becomes the intent. Only the origin is normalized into the
   target display's work area; the size is preserved even when the target work
   area is smaller, because base bounds are the restorable intent under ADR 0122
   and a shrink here would be persisted permanently.
4. Classify the transition by whether an unaccounted native `move` stream
   precedes it. A drag is the only cross-display transition that follows one.
   The marker is a flag, not a deadline, so attribution never depends on how
   long the main process took to reach the classification, and it survives the
   deferred geometry of a maximized or fullscreen window.
5. Never re-plan bounds mid-drag. The `move` handler only marks the user-move
   window and defers display reconciliation until the move stream goes quiet.
6. Persist base bounds for both `none` and `user-moved`, and advance the
   remembered display key on `user-moved`, so relaunch restores the display the
   user actually left the window on. `os-adjusted` still refuses to persist.
   The persistence path normalizes a dragged-in base the same way, because a
   maximized or fullscreen window defers reservation geometry and leaves this as
   the only consumer of the drag.
7. Retire an unconsumed marker on a deadline. The deadline bounds how long a
   marker can linger when no consumer runs; it never decides attribution.
8. A forced bounds recovery (the Stage Manager path) clears the pending
   user-move attribution, because it is not user intent.

## Consequences

- Dragging the window between displays keeps the position where it was
  dropped, with no jump on pointer release.
- Relaunch reopens the window on the display it was last used on.
- ADR 0122's constrained-display reservation behavior is preserved verbatim for
  OS-owned adjustments, including the restore path back to a roomy display.
- Display topology events clear the pending marker before reconciling, so a
  display added, removed, or rescaled right after a drag is still classified as
  OS-owned.
- A window dropped onto a display whose work area cannot hold it keeps its size
  and is pinned to the work area's top-left. `planWorkPanelReservation` still
  caps the width it adds, so the reservation shrinks instead of the window.
- No IPC, storage, or host protocol change. `window/setWorkPanelReservation`
  keeps its request/response shape.

## Alternatives

### Clamp the remembered base bounds into the new display

Rejected. It keeps the window on the target display but discards the drop
position, which is the reported symptom rather than a fix for it.

### Skip reservation planning entirely on a display change

Rejected. The reservation would then be sized for the previous display's work
area, so a narrower target display would leave the window wider than its work
area.

### Detect drags from pointer state instead of the move stream

Rejected for now. Electron exposes no drag-begin/drag-end pair for native
window moves, and polling the pointer during a drag costs more than the
pending-move marker it would replace.

### Attribute the drag with a time deadline

Rejected. A deadline makes correctness depend on main-process scheduling: a
busy main process, or a maximized window that defers its geometry past the
deadline, would silently fall back to the buggy OS-adjusted path.

## References

- `apps/desktop/electron/main/work-panel-window.ts`
- `apps/desktop/electron/main/index.ts`
- `apps/desktop/test/work-panel-window.test.mjs`
- `docs/adr/0122-reserve-native-width-while-work-panel-visible.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-160)
- `docs/spec/08-meta/decisions-log.md` (D263)
