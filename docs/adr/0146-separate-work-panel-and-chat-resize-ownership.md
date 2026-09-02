# ADR 0146: Assign outer and inner work-panel resize ownership by boundary

- Status: Accepted
- Date: 2026-09-02
- Related: ADR 0122, ADR 0132

## Context

The visible work panel is an in-flow right column backed by a native width
reservation. Its renderer divider and the native window's right edge are both
resize affordances, but assigning both gestures to the same dimension makes it
impossible to adjust the panel without changing the conversation width, or to
adjust the conversation without changing the panel preference.

## Decision

When the work panel is open:

- The outer native right edge, including right corners where Electron reports
  them, owns the panel target. Main keeps the base conversation width fixed,
  previews the bounded `244..720px` panel target to the renderer, and commits
  the target after the native resize stream settles. The native minimum is
  temporarily lowered to allow the panel target to reach its minimum.
- The inner renderer divider owns the base conversation width. Pointer and
  keyboard changes use the bounded `window/setWorkPanelChatWidth({width})`
  target-state channel (`1040..10000px`) and preserve the current panel
  reservation. Requests are serialized so a fast pointer stream cannot reorder
  native bounds updates; cancellation sends the press-time target again.
- Left and non-right native edges retain their existing base-window behavior.
  Display transitions, maximized/fullscreen deferral, persisted base bounds,
  and work-area reservation clamping continue to follow ADR 0122 and ADR 0132.

The event is Electron-local and does not change the host protocol version.

## Consequences

The two resize gestures have an unambiguous dimension owner. The renderer must
temporarily block composited Browser and plugin views during either gesture,
and the panel separator's accessible value describes the conversation target,
not the panel target. Linux uses the main-process right-edge cursor position as
the fallback because Electron's `will-resize` edge detail is not available on
that platform.

## Alternatives rejected

- Keep the old renderer divider as the panel resizer and let native edges resize
  the chat: this does not satisfy the requested boundary ownership.
- Expose an unrestricted BrowserWindow resize IPC: this would weaken the
  target-state and validation boundary without being needed for either gesture.
