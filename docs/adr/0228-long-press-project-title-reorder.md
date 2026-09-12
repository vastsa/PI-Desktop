# ADR 0228: Long-press the project title to reorder

- Status: Accepted (amended by 0229)
- Date: 2026-09-11
- Amends: [ADR 0227](0227-project-group-manual-ordering.md)
- Related: [D402](../spec/08-meta/decisions-log.md) · [Component spec](../spec/04-ux/08-component-spec.md) · E2E-253

## Context

ADR 0227 added renderer-local manual project order behind a hover/focus
grip. The grip consumed a leading column, stayed hidden until hover, and
made reorder a second control beside the title that already selects and
collapses the group.

## Decision

Retained project groups no longer render a reorder grip. The project title
is the reorder control:

- A still press of 400ms on the title arms a pointer reorder. Pointer
  movement beyond 8px before that delay cancels the press so a click still
  activates the project and toggles collapse.
- After the title is armed, moving the pointer highlights another group in
  the same pinned/archived bucket; release inserts before or after that
  group from the pointer's vertical midpoint. Escape cancels without writing
  order.
- ArrowUp/ArrowDown on the focused title remains the keyboard path.
- Persistence is unchanged: contiguous normalized-path `order` values and
  `projectSort: "manual"` in renderer-local sidebar preferences.

The title's path tooltip dismisses on press so it does not cover the drag.
Session-to-project HTML5 drops and native folder drops are unchanged.

## Consequences

- Reorder no longer needs a dedicated visible handle.
- Long-press is the pointer disambiguation for a title that also clicks.
- Keyboard users keep ArrowUp/ArrowDown on the same title button.

## References

- `apps/desktop/src/components/Sidebar.tsx`
- `apps/desktop/src/lib/sidebar-project-reorder.ts`
- `apps/desktop/test/sidebar-project-reorder.test.mjs`
