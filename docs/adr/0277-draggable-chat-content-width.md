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

The conversation column, empty-home stack, and composer were capped at
760–768px (640px while the sidebar was collapsed) so a wide shell would not
become a low-density reading surface. Code, tables, diagrams, and tool output
then wrapped inside a second 720px assistant cap, and there was no way to
spend the extra pane width when the user wanted it.

A Comfort/Wide toggle was rejected: two presets cannot match monitor size,
work-panel squeeze, or a one-off wider reading of a diff.

## Decision

1. The transcript, empty-home stack, and composer share one preferred max
   width, default **760px**, persisted as `AppSettings.chatContentMaxWidth`.
   Absent or invalid values keep 760. The live band is always
   `min(available pane minus 24px gutters, preferred)`, so a squeezed
   sidebar or work panel compresses the band without rewriting the
   preference.
2. Two 12px handles sit on the left and right edges of that centered band,
   from the top of `.chat-surface` down to the composer dock. Both handles
   change the same width (1px pointer → 2px band) so the column stays
   centered. Drag minimum is **560px**, or the available pane if smaller.
3. Rest: the handles are invisible. Hover/focus: a short 2×40px capsule mixed
   from `--ds-text-primary` (18% on dark, 12% on light). Drag: both capsules
   lengthen to 56px at a slightly stronger mix. Double-click resets to 760.
   Arrow keys step 16px (Shift 32px); Home restores 760; End expands to the
   pane; Escape cancels an in-flight drag.

4. User bubbles stay `min(82%, 600px)`. Assistant, tool, permission, ask,
   review, and turn-outcome rows follow `--chat-prose-max-width`, which
   tracks the band. The collapsed-sidebar 640px ceiling is removed.
5. Renderer only: no protocol, storage schema, host, or IPC change. Host-core
   already preserves unknown settings keys.

## Consequences

- Users who never touch the handles keep today's 760px column, including
  after collapsing the sidebar (the pane grows; the band does not jump to
  640px).
- A saved 1100px preference on a large window compresses cleanly when the
  work panel opens, then returns when it closes.
- Handle hit targets can sit near the minimap when the band is almost full
  pane width; the 24px gutter keeps both usable.

## Rejected alternatives

- **Comfort / Wide presets:** cannot match the live pane or a one-off width.
- **Independent left/right insets:** un-centers the column and fights the
  composer, which is also centered.
- **Full-bleed to the pane edge by default:** reopens the over-wide reading
  surface the 760px cap was there to prevent.
