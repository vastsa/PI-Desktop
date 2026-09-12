# ADR 0195: Viewport-fixed work panel toggle

- Status: Accepted
- Date: 2026-09-09
- Deciders: PI-Desktop core
- Amends: ADR 0068, ADR 0085, D128, D207, D221
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-056, E2E-070, US-UI-57

## Context

ADR 0068 restored `Cmd/Ctrl + J` as a renderer-local way to reveal a session's
retained work-panel context without creating a tab. ADR 0085 made that chord a
toggle. Pointer users still had no equivalent: the panel opened from an
artifact or the shortcut, and collapse lived in the panel header. That left
the surface undiscoverable for anyone who does not already know the chord.

D128's remaining "no titlebar/menu command" clause was aimed at D097's empty
fixed-tab launcher, not at a Cmd/Ctrl+J equivalent that creates no resource.

## Decision

1. AppShell owns one viewport-fixed toggle in the top-right corner of every
   non-Settings route. It is the pointer equivalent of `openWorkPanel`: it
   reveals the active session's retained context without creating a tab, and
   collapses a visible panel without deleting tabs. With no active session it
   is disabled. Settings still has no panel and no toggle.
2. The button prefers the visible presentation, including a subagent dock,
   over a briefly stale store projection. A click during the exit animation
   reopens. `aria-pressed` follows both store state and the presented panel.
3. The toggle is the sole panel-level collapse control. The work-panel header
   keeps resource close, not a second chevron.
4. Windows/Linux window controls stay viewport-fixed at the window's right
   edge so they do not slide with MainPane during the dock animation. While
   the panel is open, the panel header reserves that control band plus the
   toggle; the conversation titlebar does not keep a leftover 120px gap at
   the divider. No host protocol, IPC channel, or native application-menu
   command is added.

## Consequences

- Pointer users can find and put away the work panel without a shortcut.
- Artifact-driven tab creation, session-scoped contexts, and startup-closed
  behavior from D128 / D142 remain unchanged.
- The panel header is no longer a full-width action row on Windows/Linux
  while the panel is open; close-tab sits left of the reserved overlay.

## Alternatives considered

### Keep the header chevron and add a closed-state titlebar button

Rejected. Two collapse controls occupy the same corner once the toggle is
viewport-fixed over the open panel.

### Leave window controls in-flow in MainPane

Rejected for this chrome. Absolute in-pane controls travel with the shrinking
conversation column while the toggle stays on the viewport, so the native
min/max/close cluster and the toggle split during the animation.

## References

- `docs/adr/0068-work-panel-keyboard-entry.md`
- `docs/adr/0085-work-panel-shortcut-toggle.md`
- `docs/spec/08-meta/decisions-log.md` (D128, D207, D221, D357)
