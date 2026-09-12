# ADR 0229: Press-and-move project title reorder

- Status: Accepted
- Date: 2026-09-11
- Amends: [ADR 0228](0228-long-press-project-title-reorder.md)
- Related: [D403](../spec/08-meta/decisions-log.md) · [Component spec](../spec/04-ux/08-component-spec.md) · E2E-253

## Context

ADR 0228 removed the reorder grip and armed a drag after a 400ms still
press. That delay is a mobile long-press pattern. On a desktop sidebar it
makes reorder slower than ChatGPT, Claude, and similar product lists, where
grabbing a row and moving it starts the drag immediately.

## Decision

The project title remains the reorder control, with no grip. Pointer
disambiguation is movement, not time:

- Mouse and pen: an 8px move while pressed arms the drag. A click with no
  qualifying movement still selects the project and toggles collapse.
- Touch presses do not start a reorder, so a one-finger pan can scroll the
  list. Keyboard ArrowUp/ArrowDown on the focused title remains available.
- While dragging, an accent insertion line on the target group shows
  before/after placement from the pointer's vertical midpoint. Escape
  cancels. Persistence and pin/archive buckets are unchanged.

## Consequences

- Desktop reorder matches common sidebar lists: press, move, drop.
- Touch scrolling is not stolen by an accidental 8px pan on a title.
- The 400ms still-press contract in ADR 0228 is replaced.

## References

- `apps/desktop/src/components/Sidebar.tsx`
- `apps/desktop/src/lib/sidebar-project-reorder.ts`
- `apps/desktop/test/sidebar-project-reorder.test.mjs`
