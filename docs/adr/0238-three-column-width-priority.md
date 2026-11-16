# ADR 0238: Prioritize MainChat in the three-column shell

- Status: Accepted (sidebar width clamp amended by
  [ADR 0290](0290-resizable-sidebar-collapse-threshold.md); amends ADR 0226,
  ADR 0151, and ADR 0033, whose fixed `244..720px` panel clamp is replaced by the
  live budget below)
- Date: 2026-09-13
- Related: D167, D433, ADR 0033, ADR 0151, ADR 0226, ADR 0290

## Context

The renderer shell has three in-flow columns inside a fixed client area — expanded
sidebar, MainChat, and work panel — but no explicit width priority: the ADR 0226
chat reservation and the fixed panel range left pointer resizing, keyboard resizing,
sidebar toggles, and window resizing under different rules, so a narrow window could
pin MainChat to its floor while the expanded sidebar kept full width.

## Decision

1. MainChat has a hard minimum derived from the composer toolbar's unfolded row plus
   margins; the work-panel maximum is the remaining client width after that floor and
   the expanded sidebar, with no fixed cap, and one shared renderer budget function
   serves pointer preview, keyboard resize, panel presentation, sidebar changes, and
   shell resize observation.
2. When the expanded sidebar would push MainChat to the floor, the renderer
   immediately collapses the sidebar through the existing mounted `sidebar-out`
   animation; while that animation still occupies flex space the budget keeps
   counting the sidebar, and the preferred panel width stays the persisted user
   target.
3. A manual sidebar reopen spends work-panel width first, preserving current MainChat
   width and lending the panel a compact width below its ordinary presentation
   minimum; the loan holds while the sidebar stays expanded, extra client width
   returns to the panel first, and collapsing the sidebar or resizing the panel ends
   it, with the preferred width still stored as the resize target.
4. Automatic sidebar collapse is remembered only until the work panel closes, which
   restores the sidebar; manual collapse, manual reopen, and a subsequent manual
   collapse clear that record.
5. The window itself stays fixed: the renderer keeps
   `window/setWorkPanelReservation` at zero and Main normalizes every valid request to
   `{ requested: 0, reserved: 0 }` without applying width or x-offset geometry
   (ADR 0033 / ADR 0151).
6. The panel header exposes a preview (maximize) toggle: while on, MainChat is not
   rendered and the panel takes the whole client area beside the sidebar, so the chat
   floor is suspended by design; leaving preview restores the previous panel width and
   the last sidebar state, and the mode is transient, never persisted, and never
   changes native bounds. AppShell then supplies a window-level chrome row with New
   Task, sidebar, and native window controls, whose spacer passes pointer events
   through outside controls, and the panel header is the sole drag owner in the
   preview pane.

## Consequences

- MainChat cannot be compressed below its floor by any supported shell width change;
  the sidebar is the column that yields, and a constrained window shows a narrower
  panel while the persisted preferred width returns with space.
- The composer toolbar handles widths between the floor and its comfortable layout
  instead of relying on a fixed reservation, so its control groups ellipsize or
  reflow.
- No host protocol, SQLite schema, plugin contract, security boundary, or native
  window geometry changes.

## Alternatives

- Keep the ADR 0226 reservation: it leaves side-dock priority implicit and cannot
  satisfy the floor with automatic sidebar yield.
- Mirror the committed panel width into native bounds: expanding the window is the
  outward behavior ADR 0033 and ADR 0151 removed.
