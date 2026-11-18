# ADR 0224: Right Panel Tab Strip and Data-Driven Add Menu

- Status: Accepted
- Date: 2026-09-11
- Related: Issue #229

## Context

The right work panel used one header menu for both tool launchers and
conversation-opened resources, so open resources were hard to scan, close actions
sat far from their tabs, and the menu could become a second scrolling surface.

## Decision

The work-panel header becomes a horizontally scrollable tab strip followed by a
fixed `+` trigger, with every open Review, file, or plugin view as one ARIA tab that
activates on click, closes from its own button or middle-click, reorders by pointer
drag or `Alt+ArrowLeft`/`Alt+ArrowRight`, keeps keyboard navigation and
Delete/Backspace closing, and auto-scrolls near the edges while dragging. Closing
the final tab keeps the panel open and shows a New launcher in the body.

The `+` menu has one **Tools & panels** group whose only host-owned entry is Review,
every other entry coming from the plugin-view metadata in `contributes.views`, so the
renderer hardcodes neither Files nor Browser. Plugin views stay singleton tabs, and
the viewport-fixed toggle remains the sole collapse control with a tooltip naming the
resolved `Mod+J` binding. No protocol, persisted tab schema, or native-window
reservation is introduced.

## Consequences

- The active resource and its close affordance are visible without losing panel width
  or the native-surface occlusion boundary.
- The New launcher offers an intentional next action after the last tab closes.
- Plugin authors get a launcher from their view contribution, so the host list cannot
  drift from plugin metadata.

## Alternatives

- Keep one header menu for launchers and resources — rejected: it hides open resources
  and grows into a second scrolling surface.
