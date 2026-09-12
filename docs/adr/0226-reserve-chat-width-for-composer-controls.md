# ADR 0226: Reserve Chat Width for Composer Controls

- Status: Superseded by [ADR 0235](0235-three-column-width-priority.md)
- Date: 2026-09-11
- Amends: [ADR 0151](0151-internal-work-panel-dock.md)
- Related: [07-ui-design-system §10](../spec/04-ux/07-ui-design-system.md) ·
  [08-component-spec §1 and §11](../spec/04-ux/08-component-spec.md) · E2E-168

## Context

The sidebar and in-flow work panel can both take flex space from MainChat.
When the remaining chat column becomes too narrow, the floating composer
toolbar squeezes its localized chips or wraps its control groups. A visual
overlap with a side dock is not an acceptable fallback for an input surface.

## Decision

MainPane and its chat surface reserve a 515px minimum width. This reservation
belongs to the chat flex item, so sidebar and work-panel resize gestures cannot
consume or paint over the space needed by the composer.

The composer toolbar stays single-row with `flex-wrap: nowrap`, and its left and
right control groups are non-shrinking flex items. Mode and permission labels
remain single-line and use chip-local ellipsis when their localized text is
longer than the available label slot.

The work panel remains an in-flow renderer-owned column and does not request a
positive native window reservation; this decision only changes the minimum
space MainChat retains inside the renderer shell.

## Consequences

- Sidebar and work-panel resizing preserve a readable composer control row.
- At a constrained client width, the shell may need more horizontal space than
  the native minimum to show every fixed-width column simultaneously; the
  composer reservation takes priority over flex compression and overlap.
- The 515px minimum is the shared renderer/test contract for MainPane layout.

## Alternatives rejected

### Wrap the toolbar below a narrow threshold

Rejected because the toolbar becomes taller during a side-dock gesture and the
bottom controls stop presenting as one stable action row.

### Allow side docks to overlap the composer

Rejected because it hides input actions and creates pointer/focus ambiguity.

## References

- `apps/desktop/src/styles/chat-shell.css`
- `apps/desktop/src/styles/composer.css`
- `apps/desktop/src/lib/work-panel-resize.ts`
