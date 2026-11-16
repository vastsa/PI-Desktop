# ADR 0277: Draggable Chat Content Width

- Status: Accepted
- Date: 2026-09-16
- Deciders: PI-Desktop desktop UI maintainers
- Amends: D058, D101, the collapsed-sidebar 640px band
- Related: [04-ux/01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [04-ux/07-ui-design-system](../spec/04-ux/07-ui-design-system.md) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [08-meta/decisions-log](../spec/08-meta/decisions-log.md) (D439) ·
  E2E-CHAT-content-width-handles · E2E-208

## Context

The conversation column, empty-home stack, and composer were capped at 760–768px
(640px while the sidebar was collapsed) so a wide shell would not become a
low-density reading surface. Code, tables, diagrams, and tool output then
wrapped inside a second 720px assistant cap, and there was no way to spend the
extra pane width when the user wanted it.

## Decision

1. The transcript, empty-home stack, and composer share one preferred max width,
   default **760px**, persisted as `AppSettings.chatContentMaxWidth`.
2. Two 12px handles sit on the left and right edges of that centered band, from
   the top of `.chat-surface` down to the composer dock.
3. Rest: the handles are invisible.

4. User bubbles stay `min(82%, 600px)`.
5. Renderer only: no protocol, storage schema, host, or IPC change.

## Consequences

- Users who never touch the handles keep today's 760px column, including after
  collapsing the sidebar (the pane grows; the band does not jump to 640px).
- A saved 1100px preference on a large window compresses cleanly when the work
  panel opens, then returns when it closes.
- Handle hit targets can sit near the minimap when the band is almost full pane
  width; the 24px gutter keeps both usable.

## Rejected alternatives

- **Comfort / Wide presets:** cannot match the live pane or a one-off width.
- **Independent left/right insets:** un-centers the column and fights the
  composer, which is also centered.
- **Full-bleed to the pane edge by default:** reopens the over-wide reading
  surface the 760px cap was there to prevent.
