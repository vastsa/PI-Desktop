# ADR 0277: Draggable Chat Content Width

- Status: Accepted
- Date: 2026-09-16
- Amends: D058, D101
- Related: [04-ux/07-ui-design-system](../spec/04-ux/07-ui-design-system.md) · [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) · [08-meta/decisions-log](../spec/08-meta/decisions-log.md) (D439) · E2E-CHAT-content-width-handles · E2E-208

## Context

The conversation column, empty-home stack, and composer were capped at a fixed
reading width so a wide shell would not become low-density, and the assistant cap
then wrapped code, tables, and tool output inside a second cap. Users had no way to
spend extra pane width on demand, and a two-preset comfort/wide toggle cannot match
monitor size or a one-off wider diff.

## Decision

1. Transcript, empty-home stack, and composer share one preferred max width,
   persisted as `AppSettings.chatContentMaxWidth` with the current column width as
   default for absent or invalid values, and the live band is always that width
   limited by the available pane minus gutters, so a squeezed work panel compresses
   it without rewriting the preference.
2. Two edge handles on the centered band adjust that single width in both
   directions and keep the column centered, with a drag minimum at the smaller of
   the configured floor and the available pane.
3. Handles are invisible at rest, become a capsule on hover or focus, lengthen
   while dragging, and support double-click, arrow-key stepping, Home, End, and
   Escape cancellation.
4. User bubbles and other transcript rows keep their own caps and follow the band
   through `--chat-prose-max-width`, and the collapsed-sidebar ceiling is removed.
5. The change is renderer-only: no protocol, storage schema, host, or IPC change,
   and host-core already preserves unknown settings keys.

## Consequences

- Users who never drag keep the current column, including after collapsing the
  sidebar.
- A wide preference compresses when the work panel opens and returns when it
  closes.
- Handles stay usable because the band keeps a gutter from the pane edges.

## Alternatives

- Comfort / Wide presets: rejected, they cannot match the live pane.
- Independent left/right insets: rejected, they un-center the column and fight the
  centered composer.
