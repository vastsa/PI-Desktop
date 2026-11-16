# ADR 0146: Assign outer and inner work-panel resize ownership by boundary

- Status: Superseded by ADR 0151
- Date: 2026-09-02
- Related: ADR 0122, ADR 0132

## Context

The visible work panel is an in-flow right column backed by a native width
reservation. Giving its renderer divider and the native window's right edge the
same dimension made it impossible to adjust the panel or the conversation alone.

## Decision

With the panel open, the outer native right edge owned the panel target: Main
kept the base conversation width fixed, previewed the bounded `244..720px` panel
target to the renderer, and committed it once the native resize stream settled.
The inner renderer divider owned the base conversation width through the bounded
`window/setWorkPanelChatWidth({width})` target-state channel
(`1040..10000px`), preserving the active panel reservation, serializing requests,
and re-sending the press-time target on cancellation. Left and non-right edges
kept their existing base-window behavior, and ADR 0151 superseded the split.
