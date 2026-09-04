# ADR 0122: Reserve native width while the work panel is visible

- Status: Superseded by ADR 0151
- Date: 2026-08-25
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D255
- Supersedes: ADR 0033; restores the native-reservation behavior from ADR 0032

## Context

The work panel is correctly rendered as an in-flow flex sibling, but the
renderer had started requesting a native reservation of `0` for every state.
When the panel collapsed, the Electron window therefore stayed at its larger
size and the main chat pane expanded into the released panel column. That
made the right edge of the application remain fixed instead of returning to
the chat-only window bounds.

The target interaction is a docked panel with stable chat width while visible:
the window grows to make room when the display work area allows it, and the
collapse path symmetrically returns the window to its pre-panel bounds.

## Decision

1. Keep the work panel as a fixed-width in-flow flex column in the renderer.
2. Before presenting an open panel, request native reservation equal to its
   committed width through `window/setWorkPanelReservation`.
3. Keep the panel mounted through its exit animation, then request reservation
   width `0` and unmount only after the request succeeds. This makes collapse
   release the panel width from the native window without an intermediate
   presentation jump.
4. Continue positioning the native Browser `WebContentsView` from the
   renderer-measured panel rectangle; native reservation only creates room for
   the in-flow panel and does not own its content geometry.
5. Preserve the existing target-state, display-aware reservation behavior:
   Main caps the added width when the work area is constrained, reverses any
   reservation-induced x shift, and leaves native edge resizing owned by Main.

## Consequences

- The conversation width remains stable while the panel is open whenever the
  display can supply the committed reservation.
- Collapsing or closing the panel shrinks the application back to its base
  bounds instead of letting chat consume the released panel width.
- On a constrained display, the panel remains fixed and chat absorbs only the
  unavoidable reservation shortfall.
- The existing renderer-to-Main IPC seam, idempotent geometry planner, and
  exit-animation lifecycle remain in use.
- The temporary visible-panel reservation is removed from persisted launch
  bounds, so relaunch still starts at the user's chat-only window size.

## Alternatives

### Keep the fixed-window internal dock from ADR 0033

Rejected because collapsing the panel leaves the application window wider than
the user's pre-panel bounds and causes chat to expand into the panel's space.

### Overlay the panel without flex allocation

Rejected because the panel would cover chat content and lose the existing
keyboard, resize, and native Browser geometry contract.

## References

- `docs/adr/0033-internal-dock-work-panel.md`
- `apps/desktop/src/App.tsx`
- `apps/desktop/electron/main/work-panel-window.ts`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-056)
- `docs/spec/08-meta/decisions-log.md` (D255)
