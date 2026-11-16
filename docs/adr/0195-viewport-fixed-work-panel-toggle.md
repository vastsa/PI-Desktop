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
toggle.

## Decision

1. AppShell owns one viewport-fixed toggle in the top-right corner of every
   non-Settings route.
2. The button prefers the visible presentation, including a subagent dock, over
   a briefly stale store projection.
3. The toggle is the sole panel-level collapse control.
4. Windows/Linux window controls stay viewport-fixed at the window's right edge
   so they do not slide with MainPane during the dock animation.

## Consequences

- Pointer users can find and put away the work panel without a shortcut.
- Artifact-driven tab creation, session-scoped contexts, and startup-closed
  behavior from D128 / D142 remain unchanged.
- The panel header is no longer a full-width action row on Windows/Linux while
  the panel is open; close-tab sits left of the reserved overlay.

## Alternatives considered

### Keep the header chevron and add a closed-state titlebar button

Rejected. Two collapse controls occupy the same corner once the toggle is
viewport-fixed over the open panel.

### Leave window controls in-flow in MainPane

Rejected for this chrome.

## References

- `docs/adr/0068-work-panel-keyboard-entry.md`
- `docs/adr/0085-work-panel-shortcut-toggle.md`
- `docs/spec/08-meta/decisions-log.md` (D128, D207, D221, D357)
